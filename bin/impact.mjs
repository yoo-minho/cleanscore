#!/usr/bin/env node
/**
 * cleanscore impact — cleanscore가 낸 PR들의 머지 상태를 GitHub에서 긁어
 * 임팩트 점수(머지 1건 = +1)를 계산하고 IMPACT.md를 재생성한다.
 *
 * 소스: impact.json (findings 레지스트리)
 * 사용: node bin/impact.mjs           # 상태 조회 + IMPACT.md 갱신
 *       node bin/impact.mjs --check    # 조회만(파일 안 씀), CI용 종료코드
 *
 * gh 불필요 — 공개 PR은 GitHub REST API로 조회(비인증 60req/h면 충분).
 * GITHUB_TOKEN 있으면 헤더에 실어 레이트리밋 완화.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "impact.json"), "utf-8"));
const findings = registry.findings || [];

async function prStatus(repo, pr) {
  const url = `https://api.github.com/repos/${repo}/pulls/${pr}`;
  const headers = { "User-Agent": "cleanscore-impact", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { state: "unknown", err: `HTTP ${res.status}` };
    const d = await res.json();
    // merged=true → 병합. state=open + draft → 초안. state=open → 열림. closed & !merged → 닫힘(거절).
    if (d.merged) return { state: "merged", url: d.html_url };
    if (d.state === "open") return { state: d.draft ? "draft" : "open", url: d.html_url };
    return { state: "closed", url: d.html_url };
  } catch (e) {
    return { state: "unknown", err: e.message };
  }
}

const LABEL = {
  merged: { icon: "✅", ko: "merged", point: 1 },
  draft: { icon: "🟡", ko: "draft", point: 0 },
  open: { icon: "🟢", ko: "open", point: 0 },
  closed: { icon: "❌", ko: "closed", point: 0 },
  unknown: { icon: "⚪", ko: "unknown", point: 0 },
};

console.log("  PR 상태 조회 중...\n");
const rows = [];
let score = 0;
for (const f of findings) {
  const st = await prStatus(f.repo, f.pr);
  const L = LABEL[st.state] || LABEL.unknown;
  score += L.point;
  const prUrl = st.url || `https://github.com/${f.repo}/pull/${f.pr}`;
  rows.push({ ...f, status: st.state, prUrl });
  console.log(`  ${L.icon} ${L.ko.padEnd(7)} #${f.pr}  ${f.title}  (${f.repo})`);
}
console.log(`\n  임팩트 점수: ${score} (머지 ${score}건)\n`);

if (checkOnly) process.exit(0);

// IMPACT.md 재생성
const tableRows = rows
  .map((r) => {
    const L = LABEL[r.status] || LABEL.unknown;
    const status = `${L.icon} ${L.ko}${r.status === "draft" || r.status === "open" ? " · 머지되면 +1" : ""}`;
    const pt = L.point ? "+1" : "—";
    return `| \`${r.title}\` | [${r.repoLabel}](https://github.com/${r.repo}) | ${r.type} | [#${r.pr}](${r.prUrl}) | ${status} | ${pt} |`;
  })
  .join("\n");

const md = `# cleanscore — 실전 성과 (impact log)

cleanscore가 **실제 오픈소스에서 찾아낸 이슈**와 그 결과. 점수판이 아니라 **증거**다 —
"청결점수"가 등급만 매기는 게 아니라, 진짜 고칠 것을 파일:줄 단위로 짚는다는 증명.

> **임팩트 점수: ${score}**
> 머지된 PR 1개 = **+1점**. (draft·open = 0, 닫힘 = 0)
>
> _(자동 생성 — \`node bin/impact.mjs\`. GitHub PR 상태 기준.)_

| 발견 | repo | 유형 | PR | 상태 | 점수 |
|------|------|------|----|------|------|
${tableRows}

## 규칙

- cleanscore가 찾은 이슈로 낸 PR만 기록한다.
- **손 검증 필수** — 정적 분석은 후보만 뽑는다. 오탐 PR은 툴 신뢰를 깎으므로 금지.
- **머지되면 +1.** 닫히면 0. 정직하게.

## 어떻게 찾았나

\`\`\`bash
npx cleanscore --dir=src --dead
\`\`\`

\`quality.io\`(루프 안 파일읽기 + DB/HTTP 순차 await)와 \`quality.dead\`(knip)가 후보를 파일:줄로
뱉는다. SonarQube가 원리상 못 잡는 축이다. 나머지는 사람의 검증.
`;

fs.writeFileSync(path.join(ROOT, "IMPACT.md"), md);
console.log("  ✓ IMPACT.md 갱신됨");

// 랜딩 임팩트 점수도 동기화 (landing.html / index.html)
for (const file of ["landing.html", "index.html"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  let s = fs.readFileSync(p, "utf-8");
  const next = s.replace(/(임팩트 점수 <b>)\d+(<\/b>)/, `$1${score}$2`);
  if (next !== s) {
    fs.writeFileSync(p, next);
    console.log(`  ✓ ${file} 임팩트 점수 → ${score}`);
  }
}
