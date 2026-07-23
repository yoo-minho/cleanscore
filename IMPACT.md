# cleanscore — 실전 성과 (impact log)

cleanscore가 **실제 오픈소스에서 찾아낸 이슈**와 그 결과. 점수판이 아니라 **증거**다 —
"청결점수"가 등급만 매기는 게 아니라, 진짜 고칠 것을 파일:줄 단위로 짚는다는 증명.

> **임팩트 점수: 0**
> 머지된 PR 1개 = **+1점**. (draft·open = 0, 닫힘 = 0)
>
> _(자동 생성 — `node bin/impact.mjs`. GitHub PR 상태 기준.)_

| 발견 | repo | 유형 | PR | 상태 | 점수 |
|------|------|------|----|------|------|
| `deleteBulkMetadata N+1` | [immich · 108k★](https://github.com/immich-app/immich) | N+1 (루프 안 순차 DELETE, item당 왕복 1회) | [#30163](https://github.com/immich-app/immich/pull/30163) | 🟡 draft · 머지되면 +1 | — |

## 규칙

- cleanscore가 찾은 이슈로 낸 PR만 기록한다.
- **손 검증 필수** — 정적 분석은 후보만 뽑는다. 오탐 PR은 툴 신뢰를 깎으므로 금지.
- **머지되면 +1.** 닫히면 0. 정직하게.

## 어떻게 찾았나

```bash
npx cleanscore --dir=src --dead
```

`quality.io`(루프 안 파일읽기 + DB/HTTP 순차 await)와 `quality.dead`(knip)가 후보를 파일:줄로
뱉는다. SonarQube가 원리상 못 잡는 축이다. 나머지는 사람의 검증.
