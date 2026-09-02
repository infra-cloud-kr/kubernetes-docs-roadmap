/**
 * 모든 노드의 url 이 실제로 살아 있는지 확인한다.
 *
 *   npx tsx scripts/check-links.ts
 *
 * 외부 네트워크에 의존하므로 PR 마다 돌리지 않는다.
 * 일시적 장애로 PR 이 막히면 기여자만 괴롭다. 주 1회 스케줄로 돌리고
 * 실패하면 이슈를 열어 메인테이너가 처리한다.
 *
 * Actions 러너에서는 kubernetes.io 쪽이 간헐적으로 연결을 끊어 매번 다른 URL 이
 * TypeError/AbortError 로 잡혔다. 이건 문서 문제가 아니라 네트워크 문제라
 * 메인테이너가 할 일이 없다. 그래서 네트워크 오류는 재시도하고, 끝까지 실패하면
 * 경고로만 남긴다. 잡을 실패시키는 건 실제로 손봐야 하는 것(깨짐/이동)뿐이다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const CONCURRENCY = 4; // kubernetes.io 에 부담을 주지 않는 선
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000; // 시도마다 2배로 늘린다
// 기본 UA(node/undici)로는 끊기는 경우가 있어 브라우저처럼 보이게 한다.
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (compatible; kubernetes-docs-roadmap link checker; +https://github.com/infra-cloud-kr/kubernetes-docs-roadmap)",
  accept: "text/html,application/xhtml+xml",
};

const nodes = readdirSync("data/nodes")
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => parse(readFileSync(join("data/nodes", f), "utf8")) as { id: string; url: string })
  .sort((a, b) => a.id.localeCompare(b.id));

type Result = { id: string; url: string; status: number | string; redirect?: string };
const bad: Result[] = []; // 손봐야 하는 것: HTTP 오류 + 이동
const unreachable: Result[] = []; // 재시도해도 응답이 없던 것: 대개 러너 쪽 문제

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // HEAD 를 막는 CDN 이 있어 GET 을 쓰되 본문은 읽지 않는다
    return await fetch(url, { redirect: "follow", signal: ctl.signal, headers: HEADERS });
  } finally {
    clearTimeout(timer);
  }
}

async function check(n: { id: string; url: string }): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetchOnce(n.url);
      // 5xx 는 문서가 사라진 게 아니라 서버가 잠깐 죽은 것이므로 재시도한다.
      if (res.status >= 500 && attempt < ATTEMPTS) {
        lastError = String(res.status);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      if (!res.ok) {
        bad.push({ id: n.id, url: n.url, status: res.status });
        return;
      }
      // 리다이렉트되었다면 문서가 이동한 것이다. 에러는 아니지만 url 을 갱신해야 한다.
      const final = res.url.replace(/\/$/, "");
      if (final !== n.url.replace(/\/$/, "")) {
        bad.push({ id: n.id, url: n.url, status: "moved", redirect: res.url });
      }
      return;
    } catch (e) {
      lastError = (e as Error).name; // TypeError(연결 실패) 또는 AbortError(타임아웃)
      if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  unreachable.push({ id: n.id, url: n.url, status: lastError });
}

const queue = [...nodes];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await check(queue.shift()!);
  })
);

const byId = (x: Result, y: Result) => x.id.localeCompare(y.id);

if (unreachable.length > 0) {
  console.error(`\n! ${ATTEMPTS}번 시도해도 응답이 없는 URL ${unreachable.length}개:\n`);
  for (const b of unreachable.sort(byId)) console.error(`  ${b.id}  [${b.status}]  ${b.url}`);
  console.error(`\n네트워크 쪽 문제일 가능성이 크다. 브라우저에서 열리면 무시해도 된다.\n`);
}

if (bad.length === 0) {
  console.log(`✓ ${nodes.length - unreachable.length}개 URL 정상`);
  process.exit(0);
}

console.error(`\n✗ 확인이 필요한 URL ${bad.length}개:\n`);
for (const b of bad.sort(byId)) {
  console.error(`  ${b.id}  [${b.status}]  ${b.url}`);
  if (b.redirect) console.error(`      → ${b.redirect}`);
}
console.error(`\n"moved" 는 문서가 이동한 것이므로 data/nodes/<id>.yaml 의 url 을 갱신하세요.\n`);
process.exit(1);
