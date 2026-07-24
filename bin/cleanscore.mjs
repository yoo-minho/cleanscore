#!/usr/bin/env node
/**
 * m1kkit stats — 프로젝트의 코드량과 kit 사용 현황을 분석해서 .kit-stats.json 생성
 *
 * Usage:
 *   m1kkit stats                    # src/ 기준 분석 (git 추적 파일만, 빌드산출물 제외)
 *   m1kkit stats --dir=app          # 특정 디렉토리 기준
 *   m1kkit stats --out=public       # 출력 위치 지정
 *   m1kkit stats --dead             # (선택) knip 데드코드축 — 죽은 파일·미사용 export 감점
 *                                   #   프로젝트 전체를 1회 분석(느림). // @keep 주석 파일은 집계 제외.
 *   m1kkit stats --llm              # (선택) Claude로 네이밍·응집도 자문 — 점수엔 미반영
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { execFileSync } from "child_process";

const args = process.argv.slice(2);
const getFlag = (name) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : undefined;
};

const srcDir = path.resolve(process.cwd(), getFlag("dir") || "src");
const outDir = path.resolve(process.cwd(), getFlag("out") || "public");
const wantDead = args.includes("--dead"); // 데드코드축(knip) 옵트인 — 느리므로 기본 off
const wantBadge = args.includes("--badge"); // README·사이트 임베드용 SVG 배지 생성

// 등급 색 (라이트 기준) — 배지·임베드 공용
const GRADE_COLORS = { "A+": "#12915a", A: "#12915a", B: "#b6841a", C: "#d4701a", D: "#cb4436" };

// shields 스타일 SVG 배지 생성 — "clean score | A · 90"
function makeBadgeSvg(grade, score) {
  const left = "clean score";
  const right = `${grade} · ${score}`;
  const color = GRADE_COLORS[grade] || "#888";
  const cw = 6.6; // 대략적 글자 폭(px, 11pt)
  const lw = Math.round(left.length * cw) + 16;
  const rw = Math.round(right.length * cw) + 18;
  const w = lw + rw;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#3b3b40"/>
    <rect x="${lw}" width="${rw}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="11">
    <text x="${lw / 2}" y="14">${esc(left)}</text>
    <text x="${lw + rw / 2}" y="14" font-weight="bold">${esc(right)}</text>
  </g>
</svg>`;
}

// kit의 meta.json에서 실제 측정된 LOC 로드
let KIT_FEATURES = {};
let kitVersion = "unknown";
let kitTotalFeatures = { component: 0, hook: 0, util: 0 };

// meta.json 탐색: require.resolve → node_modules 직접 탐색 → 상위 디렉토리
function findMeta() {
  // 1. require.resolve
  try {
    const require = createRequire(path.resolve(process.cwd(), "package.json"));
    return require.resolve("@m1kapp/kit/dist/meta.json");
  } catch {}

  // 2. node_modules에서 직접 탐색
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "@m1kapp", "kit", "dist", "meta.json");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  // 3. 이 스크립트가 kit 안에 있으면 형제 dist/ 탐색
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const siblingMeta = path.join(scriptDir, "..", "dist", "meta.json");
  if (fs.existsSync(siblingMeta)) return siblingMeta;

  return null;
}

// 청결점수는 kit과 무관하게 동작한다. meta.json은 (선택적) kit 활용도 통계용일 뿐 —
// 없으면 조용히 건너뛴다. "저자 UI kit을 강제로 요구하고 광고한다"는 인상을 주지 않기 위함.
const metaPath = findMeta();
let hasKitMeta = false;
if (metaPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    KIT_FEATURES = meta.features || {};
    kitVersion = meta.version || "unknown";
    for (const f of Object.values(KIT_FEATURES)) {
      kitTotalFeatures[f.category] = (kitTotalFeatures[f.category] || 0) + 1;
    }
    hasKitMeta = Object.keys(KIT_FEATURES).length > 0;
  } catch {}
}

// 소스 파일 수집
function collectFiles(dir, exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      results.push(...collectFiles(fullPath, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

// git 추적 파일 집합 (빌드산출물·gitignore 대상 제외). git repo 아니면 null 반환 → 폴백.
function gitTrackedSet(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
    const set = new Set();
    for (const rel of out.split("\0")) {
      if (rel) set.add(path.resolve(dir, rel));
    }
    return set.size > 0 ? set : null;
  } catch {
    return null;
  }
}

// knip 바이너리 위치 탐색: kit 내장(우선) → 타겟 node_modules → 없으면 null
function resolveKnipBin() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(scriptDir, "..", "node_modules", "knip", "bin", "knip.js"),
  ];
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    candidates.push(path.join(dir, "node_modules", "knip", "bin", "knip.js"));
    dir = path.dirname(dir);
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// 파일 상단에 // @keep 주석 있으면 데드 집계서 제외 (의도된 유지 = 코드밖 호출자·크론·웹훅 등)
function hasKeepAnnotation(absPath) {
  try {
    const head = fs.readFileSync(absPath, "utf-8").slice(0, 2000);
    return /@keep\b/.test(head);
  } catch {
    return false;
  }
}

// 데드코드축: knip을 git 루트서 1회 돌리고, 채점 중인 dir 하위로 귀속. @keep 화이트리스트 적용.
function analyzeDeadCode(dir, analyzedSet) {
  let gitRoot;
  try {
    gitRoot = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.log("  [dead] git repo 아님 — 데드코드축 건너뜀\n");
    return null;
  }
  const knipBin = resolveKnipBin();
  if (!knipBin) {
    console.log("  [dead] knip 미설치 — 데드코드축 건너뜀 (npm i -O knip)\n");
    return null;
  }
  console.log("  [dead] knip 분석 중... (프로젝트 전체, 수십초~분)\n");
  let raw;
  try {
    raw = execFileSync("node", [knipBin, "--reporter", "json", "--no-progress"], {
      cwd: gitRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (e) {
    // knip은 이슈 발견 시 exit 1 — stdout은 여전히 유효
    raw = e.stdout ? e.stdout.toString() : "";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log("  [dead] knip 출력 파싱 실패 — 건너뜀\n");
    return null;
  }
  const issues = Array.isArray(parsed) ? parsed : parsed.issues || [];
  let deadFiles = 0, keptFiles = 0, unusedExports = 0;
  const deadFileList = [];
  for (const it of issues) {
    const abs = path.resolve(gitRoot, it.file || "");
    if (!abs.startsWith(dir + path.sep) && abs !== dir) continue; // 채점 dir 밖 제외
    // 실제 분석 대상 파일만 — 테스트·벤치·타입선언·자잘 파일은 점수 파일집합에서 이미 빠졌으므로
    // 데드 집계에서도 빼야 일관된다(knip은 .test/benchmarks도 "미사용"으로 보고 → 오집계·pct>100 방지).
    if (analyzedSet && !analyzedSet.has(abs)) continue;
    const fileIsDead = Array.isArray(it.files) && it.files.length > 0;
    const keep = hasKeepAnnotation(abs);
    if (fileIsDead) {
      if (keep) { keptFiles++; continue; }
      deadFiles++;
      if (deadFileList.length < 15) deadFileList.push(path.relative(gitRoot, abs));
      continue;
    }
    if (keep) continue; // @keep 파일의 export는 집계 안 함
    unusedExports +=
      (it.exports?.length || 0) + (it.types?.length || 0) + (it.enumMembers?.length || 0);
  }
  return { deadFiles, keptFiles, unusedExports, worst: deadFileList };
}

// 줄 수 카운트 (빈 줄, 주석만 있는 줄 제외)
function countLines(content) {
  const lines = content.split("\n");
  let total = 0;
  let code = 0;
  for (const line of lines) {
    total++;
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")) {
      code++;
    }
  }
  return { total, code };
}

// 코드 청결도 분석 — 분기 밀도·파일 크기 기반 휴리스틱 (typescript 미설치 시 폴백)
// 주석/문자열 안까지 세는 러프한 근사지만, 프로젝트 간 상대 비교엔 충분
function analyzeQuality(content) {
  const branchTokens = content.match(/\bif\s*\(|\belse\b|\bcase\s|\bcatch\s*[({]|\?\s*[^.:]|&&|\|\|/g);
  const fnTokens = content.match(/\bfunction\b|=>/g);
  return { branches: branchTokens?.length || 0, functions: fnTokens?.length || 0 };
}

// 프로젝트의 typescript 패키지 로드 (AST 기반 정밀 분석용)
function loadTypescript() {
  // 1) cleanscore에 번들된 typescript를 '먼저' 쓴다 — 같은 저장소를 어디서 실행하든
  //    같은 점수가 나와야 배지가 비교 가능하다(예전엔 타겟의 TS 버전에 따라 점수가 흔들렸다).
  try {
    const req = createRequire(import.meta.url);
    return req("typescript");
  } catch {}
  // 2) 폴백: 타겟 프로젝트의 typescript.
  //    이게 없으면 타겟에 typescript 없을 때 조용히 regex 폴백으로 떨어져 점수가 달라진다(배지 비교 불가).
  try {
    const req = createRequire(path.resolve(process.cwd(), "package.json"));
    return req("typescript");
  } catch {}
  return null;
}

// AST 기반 함수별 복잡도 — cyclomatic(McCabe) + cognitive(SonarQube 근사)
// cognitive: 중첩 깊이 가중(+1+depth), 같은 논리 연산자 연쇄(a && b && c)는 1회만,
// ??는 카운트 제외(null 정규화는 복잡성이 아님). 중첩 함수는 별도 함수로 분리 집계
function analyzeAstComplexity(ts, filePath, content) {
  const kind = /\.(tsx|jsx)$/.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);

  const isFnLike = (n) =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);

  const fnName = (n) => {
    if (n.name) return n.name.getText(sf);
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf);
    if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
    return "(anonymous)";
  };

  const ccOf = (fn) => {
    let cc = 1;
    const walk = (n) => {
      if (n !== fn && isFnLike(n)) return; // 중첩 함수는 자기 항목에서 계산
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.ConditionalExpression:
        case ts.SyntaxKind.CaseClause:
        case ts.SyntaxKind.CatchClause:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
          cc++;
          break;
        case ts.SyntaxKind.BinaryExpression: {
          const op = n.operatorToken.kind;
          if (
            op === ts.SyntaxKind.AmpersandAmpersandToken ||
            op === ts.SyntaxKind.BarBarToken ||
            op === ts.SyntaxKind.QuestionQuestionToken
          ) cc++;
          break;
        }
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn, walk);
    return cc;
  };

  // cognitive complexity (SonarQube 근사)
  // - 제어 구조: +1 + 현재 중첩 깊이, 내부는 깊이+1
  // - 논리 연산자: 같은 연산자 연쇄당 1회 (&&→|| 전환 시 +1), ?? 제외
  // - 삼항: +1+depth, else(if 아닌): +1
  const cognitiveOf = (fn) => {
    let score = 0;
    const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]);
    const walk = (n, depth, parentLogicalOp) => {
      if (n !== fn && isFnLike(n)) return; // 중첩 함수는 자기 항목에서 계산
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement: {
          score += 1 + depth;
          walk(n.expression, depth, null);
          walk(n.thenStatement, depth + 1, null);
          if (n.elseStatement) {
            if (n.elseStatement.kind === ts.SyntaxKind.IfStatement) {
              // else if — if 쪽에서 +1+depth 처리되므로 여기선 그대로 위임 (깊이 유지)
              walk(n.elseStatement, depth, null);
            } else {
              score += 1; // else 자체
              walk(n.elseStatement, depth + 1, null);
            }
          }
          return;
        }
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.CatchClause:
        case ts.SyntaxKind.ConditionalExpression: {
          score += 1 + depth;
          ts.forEachChild(n, (c) => walk(c, depth + 1, null));
          return;
        }
        case ts.SyntaxKind.SwitchStatement: {
          score += 1 + depth; // switch 전체 1회 (case별 아님)
          ts.forEachChild(n, (c) => walk(c, depth + 1, null));
          return;
        }
        case ts.SyntaxKind.BinaryExpression: {
          const op = n.operatorToken.kind;
          if (LOGICAL.has(op)) {
            if (op !== parentLogicalOp) score += 1; // 연쇄의 시작에서만
            walk(n.left, depth, op);
            walk(n.right, depth, op);
            return;
          }
          break;
        }
      }
      ts.forEachChild(n, (c) => walk(c, depth, null));
    };
    ts.forEachChild(fn, (c) => walk(c, 0, null));
    return score;
  };

  const fns = [];
  const collect = (n) => {
    if (isFnLike(n) && (n.body || ts.isArrowFunction(n))) {
      fns.push({
        name: fnName(n),
        cc: ccOf(n),
        cog: cognitiveOf(n),
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  return fns;
}

// 중복 코드 감지 — 토큰 정규화(식별자/리터럴 치환) + 슬라이딩 윈도우 해시 (jscpd 라이트)
// import 줄은 제외 (정규화하면 모든 import가 동일해져 가짜 중복 발생)
const DUP_WINDOW = 50; // 토큰 수 ≈ 코드 5~8줄

function tokenizeNormalized(ts, filePath, content) {
  // import/export-from 줄 제거
  const stripped = content
    .split("\n")
    .map((l) => (/^\s*(import\s|export\s+(\{|\*).*\sfrom\s)/.test(l) ? "" : l))
    .join("\n");
  const kind = /\.(tsx|jsx)$/.test(filePath) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, kind, stripped);
  const lineStarts = [0];
  for (let i = 0; i < stripped.length; i++) if (stripped.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOfOffset = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const tokens = [];
  const lines = [];
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    let norm;
    // 식별자 원문 유지 — 이전엔 전부 "I"로 정규화했으나, 스키마/타입 라이브러리처럼
    // 구조가 일관된 코드(parseUser vs parseOrder)를 전부 복붙으로 오인해 존경 OSS(zod 34%·
    // valibot 67%)를 학살했다. 원문 유지 시 '정확한 복붙'은 여전히 잡히고(네거티브 검증 99%),
    // 구조적 유사 오탐만 제거된다. 트레이드: 변수명 바꾼 복붙은 못 잡음(정밀도 우선).
    if (tok === ts.SyntaxKind.Identifier) norm = scanner.getTokenText();
    else if (tok === ts.SyntaxKind.JsxText) { tok = scanner.scan(); continue; } // 마크업 텍스트 제외
    else if (tok === ts.SyntaxKind.StringLiteral || tok === ts.SyntaxKind.NoSubstitutionTemplateLiteral || tok === ts.SyntaxKind.NumericLiteral) norm = scanner.getTokenText();
    else norm = String(tok);
    tokens.push(norm);
    // 토큰 시작 위치의 줄 번호 — 줄 시작 오프셋을 한 번만 만들고 이진탐색한다.
    // (예전엔 토큰마다 slice+split 해서 파일 길이의 제곱으로 느려졌다. 20k줄 파일이 80초 걸렸다.)
    lines.push(lineOfOffset(scanner.getTokenStart()));
    tok = scanner.scan();
  }
  return { tokens, lines };
}

function analyzeDuplication(ts, fileContents) {
  // 테스트 파일은 제외 — 반복 구조(케이스 나열)가 본질이라 중복 밀도를 왜곡
  const perFile = fileContents
    .filter(({ file }) => !/\.(test|spec)\.[tj]sx?$/.test(file))
    .map(({ file, content }) => ({
      file,
      ...tokenizeNormalized(ts, file, content),
    }));

  // 윈도우 해시 → 등장 위치 목록
  const seen = new Map(); // hash → [{fi, idx}]
  perFile.forEach((f, fi) => {
    for (let i = 0; i + DUP_WINDOW <= f.tokens.length; i++) {
      let h = 5381;
      for (let k = 0; k < DUP_WINDOW; k++) {
        const s = f.tokens[i + k];
        for (let c = 0; c < s.length; c++) h = ((h * 33) ^ s.charCodeAt(c)) >>> 0;
      }
      const arr = seen.get(h);
      if (arr) arr.push({ fi, idx: i });
      else seen.set(h, [{ fi, idx: i }]);
    }
  });

  // 2회 이상 등장한 윈도우가 덮는 토큰 마킹
  const dupMask = perFile.map((f) => new Uint8Array(f.tokens.length));
  const blockKeys = new Set(); // 대표 위치 수집용
  const examples = new Map(); // hash → [위치 문자열]
  for (const [h, locs] of seen) {
    if (locs.length < 2) continue;
    // 같은 파일 안 인접 중첩(자기 자신과 1토큰 시프트) 제외: 서로 다른 위치 그룹만
    const distinct = locs.filter((a, i) => locs.findIndex((b) => b.fi === a.fi && Math.abs(b.idx - a.idx) < DUP_WINDOW) === i);
    if (distinct.length < 2) continue;
    for (const { fi, idx } of distinct) {
      dupMask[fi].fill(1, idx, idx + DUP_WINDOW);
    }
    blockKeys.add(h);
    if (examples.size < 200 && !examples.has(h)) {
      examples.set(h, distinct.slice(0, 3).map(({ fi, idx }) => `${perFile[fi].file}:${perFile[fi].lines[idx]}`));
    }
  }

  let dupTokens = 0;
  let totalTokens = 0;
  const byFile = new Map();
  perFile.forEach((f, fi) => {
    totalTokens += f.tokens.length;
    let d = 0;
    for (let i = 0; i < dupMask[fi].length; i++) d += dupMask[fi][i];
    dupTokens += d;
    if (d > 0) byFile.set(f.file, d);
  });

  const percent = totalTokens > 0 ? Math.round((dupTokens / totalTokens) * 1000) / 10 : 0;
  const worstFiles = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([file, d]) => ({ file, dupTokens: d }));
  // 대표 중복 블록 예시 (여러 위치에 나타나는 것 우선)
  const worstBlocks = [...examples.values()].sort((a, b) => b.length - a.length).slice(0, 3);

  return { percent, dupTokens, totalTokens, blocks: blockKeys.size, worstFiles, worstBlocks };
}

// 파일 I/O 밀도 — "한 번 처리하는 데 파일을 몇 번이나 읽게 되는 구조인가".
// cognitive·중복은 코드 모양만 보므로, 5줄짜리 흠 없는 리더가 루프에서 120번 불리는
// 종류는 원리상 못 잡는다(그래서 요청당 492회 읽던 코드가 A+ 100점을 통과했다).
// 여기선 리더 함수를 찾고, 그게 루프 안에서 불리는 자리를 센다. 리더가 캐시를 끼고
// 있으면 반복 호출돼도 실제 읽기는 한 번이라 감점하지 않고 참고로만 남긴다.
const FILE_READ_CALLS = new Set(["readFileSync", "readFile", "readdirSync"]);
// DB/HTTP 데이터 접근 — 루프 안에서 순차 await 하면 전형적 N+1(Sonar가 못 잡는 앱의 진짜 병목).
// 이름은 Array/Map/Promise 빌트인과 충돌하지 않는 것만(get/find/all/delete 제외 → 오탐 방지).
const DATA_CALLS = new Set([
  "query", "execute", "exec", "raw", "aggregate", "transaction",
  "findMany", "findFirst", "findUnique", "findOne", "createMany", "updateMany", "deleteMany", "upsert",
  "fetch", "request",
]);
const ITERATING_METHODS = new Set(["map", "forEach", "flatMap", "filter", "reduce", "some", "every", "find"]);
// 빌트인 컬렉션/프로토타입 메서드 — 타입정보 없이 이름만으로는 유저함수와 구분 불가.
// x.push()/map.get()/set.has() 같은 메서드 호출을 동명의 최상위 함수(리더)로 오인하면
// 코드베이스 전역에서 거대한 오탐이 난다(예: Array.push → push 리더 → 루프 IO 834개).
const BUILTIN_METHODS = new Set([
  "push", "pop", "shift", "unshift", "splice", "slice", "concat", "join", "fill", "copyWithin",
  "map", "filter", "forEach", "reduce", "reduceRight", "some", "every", "find", "findIndex",
  "flat", "flatMap", "sort", "reverse", "indexOf", "lastIndexOf", "includes", "keys", "values", "entries",
  "get", "set", "has", "add", "delete", "clear",
  "then", "catch", "finally", "toString", "valueOf", "hasOwnProperty",
]);

function analyzeIoDensity(ts, fileContents) {
  const parsed = fileContents.map(({ file, content }) => ({
    file,
    sf: ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }));

  const isFnLike = (n) =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n);

  const nameOf = (sf, n) => {
    if (n.name) return n.name.getText(sf);
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf);
    return null;
  };

  const lineOf = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // 1단계: 함수마다 "직접 파일을 읽는가 / 자기 캐시를 쓰는가 / 누구를 부르는가"를 모은다
  const fns = new Map(); // 이름 -> { file, line, readsDirectly, hasOwnCache, calls:Set }
  for (const { file, sf } of parsed) {
    const moduleHasMap = /new (Map|WeakMap)\s*[<(]/.test(sf.text);
    // 모듈 스코프 변수 이름 — "읽고 또 대입하는" 변수를 쓰면 그게 메모이제이션이다
    // (globalThis에 물린 캐시나 `let memo = null` 패턴. Map만 캐시로 보면 이런 걸 다 놓친다)
    const moduleVars = new Set();
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) moduleVars.add(decl.name.getText(sf));
        }
      }
    }

    const collect = (node) => {
      if (isFnLike(node) && node.body) {
        let readsDirectly = false;
        let mapCacheOps = 0;
        const calls = new Set();
        const readVars = new Set();
        const writtenVars = new Set();
        const rootName = (expr) => {
          let cur = expr;
          while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
          return ts.isIdentifier(cur) ? cur.getText(sf) : null;
        };
        const scan = (n) => {
          if (n !== node && isFnLike(n)) return; // 중첩 함수는 자기 항목에서 본다
          if (ts.isCallExpression(n)) {
            const callee = n.expression;
            const called = ts.isPropertyAccessExpression(callee) ? callee.name.getText(sf) : callee.getText(sf);
            if (FILE_READ_CALLS.has(called)) readsDirectly = true;
            if (called === "get" || called === "set") mapCacheOps++;
            calls.add(called);
          }
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const target = rootName(n.left);
            if (target && moduleVars.has(target)) writtenVars.add(target);
          }
          if (ts.isIdentifier(n) && moduleVars.has(n.getText(sf))) readVars.add(n.getText(sf));
          ts.forEachChild(n, scan);
        };
        ts.forEachChild(node, scan);
        const memoizesByVar = [...writtenVars].some((v) => readVars.has(v));
        const name = nameOf(sf, node);
        // 파일 스코프 키: 전역 이름충돌(다른 파일의 동명 함수가 리더면 오염) 방지.
        const key = name ? `${file}::${name}` : null;
        if (key && !fns.has(key)) {
          fns.set(key, {
            name,
            file,
            line: lineOf(sf, node),
            readsDirectly,
            // 캐시로 보는 두 형태: 모듈 Map을 get/set 하거나, 모듈 변수를 읽고 다시 대입하거나
            hasOwnCache: (moduleHasMap && mapCacheOps >= 2) || memoizesByVar,
            calls,
          });
        }
      }
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(sf, collect);
  }

  // 2단계: 호출 그래프로 "리더"를 전파한다 — getThemeComments → readJson → readFileSync 처럼
  //        직접 읽지 않고 한 다리 건너 읽는 함수가 실제 N+1의 주인공이라 이게 핵심이다.
  //        읽기 경로가 전부 캐시를 거치면 그 함수도 캐시된 리더로 본다(반복 호출돼도 읽기는 한 번).
  const readers = new Map(); // file::name -> { file, line, cached }
  for (const [key, fn] of fns) {
    if (fn.readsDirectly) readers.set(key, { file: fn.file, line: fn.line, cached: fn.hasOwnCache });
  }
  const MAX_HOPS = 2; // 얇은 래퍼(getThemeComments → readJson)까지만. 더 깊으면 전부 리더가 된다
  for (let pass = 0; pass < MAX_HOPS; pass++) {
    let changed = false;
    for (const [key, fn] of fns) {
      if (readers.has(key)) continue;
      // 호출명을 같은 파일 안에서만 리더로 해석 — 크로스파일 이름충돌 차단.
      const calledReaders = [...fn.calls]
        .filter((c) => !BUILTIN_METHODS.has(c))
        .map((c) => readers.get(`${fn.file}::${c}`))
        .filter(Boolean);
      if (calledReaders.length === 0) continue;
      readers.set(key, {
        file: fn.file,
        line: fn.line,
        cached: fn.hasOwnCache || calledReaders.every((r) => r.cached),
      });
      changed = true;
    }
    if (!changed) break;
  }

  // 3단계: 그 리더(또는 fs 읽기 자체)가 루프 안에서 불리는 자리를 찾는다.
  //        for/while뿐 아니라 map·forEach 같은 순회 콜백 안도 루프로 본다.
  const sites = [];
  for (const { file, sf } of parsed) {
    // 캐시를 직접 관리하는 함수 안에서의 읽기는 캐시 미스일 때만 나간다(2단 캐시의 디스크 티어 등)
    const walk = (node, inLoop, inCachingFn) => {
      let childInLoop = inLoop;
      let childInCachingFn = inCachingFn;
      if (isFnLike(node)) {
        const selfName = nameOf(sf, node);
        const self = selfName ? fns.get(`${file}::${selfName}`) : null;
        if (self && self.hasOwnCache) childInCachingFn = true;
      }
      switch (node.kind) {
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
          childInLoop = true;
          break;
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isMethodCall = ts.isPropertyAccessExpression(callee);
        const called = isMethodCall ? callee.name.getText(sf) : callee.getText(sf);
        // 메서드 호출(x.NAME())이 빌트인 컬렉션 메서드명이면 동명 유저함수(리더)로 해석하지 않는다.
        // 리더 해석은 같은 파일 스코프에서만 — 크로스파일 이름충돌 차단.
        const reader = (isMethodCall && BUILTIN_METHODS.has(called)) ? undefined : readers.get(`${file}::${called}`);
        if (inLoop && (FILE_READ_CALLS.has(called) || reader)) {
          const cached = inCachingFn || (reader ? reader.cached : false);
          sites.push({ file, line: lineOf(sf, node), callee: called, cached });
        }
        // DB/HTTP N+1: 루프 안에서 '직접 await' 하는 데이터 호출. Promise.all(map) 배칭은
        // 개별 호출이 직접 await 되지 않으므로(부모가 await 아님) 자동 제외 = 올바른 패턴은 안 깎임.
        if (inLoop && DATA_CALLS.has(called) && node.parent && ts.isAwaitExpression(node.parent)) {
          sites.push({ file, line: lineOf(sf, node), callee: called, cached: false });
        }
        // 순회 메서드에 넘긴 콜백 본문은 루프 안으로 취급
        if (ts.isPropertyAccessExpression(callee) && ITERATING_METHODS.has(callee.name.getText(sf))) {
          for (const arg of node.arguments) {
            if (isFnLike(arg)) walk(arg, true, childInCachingFn);
          }
        }
      }
      ts.forEachChild(node, (child) => {
        const alreadyWalked =
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ITERATING_METHODS.has(node.expression.name.getText(sf)) &&
          isFnLike(child);
        if (!alreadyWalked) walk(child, childInLoop, childInCachingFn);
      });
    };
    ts.forEachChild(sf, (n) => walk(n, false, false));
  }

  const uncached = sites.filter((s) => !s.cached);
  const readerList = [...readers.entries()].map(([name, r]) => ({ name, ...r }));
  return {
    readers: readerList.length,
    uncachedReaders: readerList.filter((r) => !r.cached).length,
    loopSites: sites.length,
    uncachedLoopSites: uncached.length,
    worst: uncached.slice(0, 5).map(({ file, line, callee }) => ({ file, line, callee })),
  };
}

// 렌더 인질 — 데이터 하나를 기다리느라 그와 무관한 UI까지 통째로 못 그리는 자리.
// `{data && <Nav a={local} b={data.x} onChange={fn} />}` 처럼 프롭 대부분이 이미 아는
// 값인데 fetch 하나 때문에 전체가 대기하면, 사용자에겐 매번 로딩으로 보인다.
// 게이트에 걸린 요소가 그 데이터에 실제로 의존하는 비율로 판정한다.
const HOSTAGE_DEP_RATIO = 0.5; // 프롭 절반도 안 쓰면서 전체를 막고 있으면 인질

// O(n²) 배열 조회 — 루프 안에서 "루프 밖에 선언된 배열"에 선형 탐색(find/findIndex/some)을 돌리는 자리.
// 루프 n번 × 탐색 m번 = O(n·m). Map/Set을 한 번 만들어 쓰면 O(n+m)이 되는 기계적 개선이라
// 취향이 개입하지 않는다(복잡도·중복과 달리 정답이 하나) — 그래서 외부 기여(PR)로도 안전한 축.
// find/findIndex/some만 본다: 배열 전용 메서드라 문자열(str.includes) 오탐이 원천 차단된다.
const QUADRATIC_METHODS = new Set(["find", "findIndex", "some"]);
// filter는 "그룹핑" 형제 패턴 — 고치는 법이 다르다(Map<key, T> 가 아니라 Map<key, T[]>).
// 역시 배열 전용이라 문자열 오탐이 없다.
const QUADRATIC_GROUP_METHODS = new Set(["filter"]);

function analyzeQuadraticLookups(ts, fileContents) {
  const sites = [];
  for (const { file, content } of fileContents) {
    const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
    const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const isFnLike = (n) =>
      ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
    const isLoopNode = (n) =>
      n.kind === ts.SyntaxKind.ForStatement || n.kind === ts.SyntaxKind.ForInStatement ||
      n.kind === ts.SyntaxKind.ForOfStatement || n.kind === ts.SyntaxKind.WhileStatement ||
      n.kind === ts.SyntaxKind.DoStatement;

    // 서브트리 안에서 선언된 이름 — 루프 안에서 만들어진 배열은 매 회 새로 만들어지므로 제외(오탐 방지)
    const declaredIn = (node) => {
      const names = new Set();
      const addBinding = (name) => {
        if (!name) return;
        if (ts.isIdentifier(name)) { names.add(name.getText(sf)); return; }
        // 구조분해도 지역 선언이다 — const { items } = row / const [a] = pair
        if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
          for (const el of name.elements) if (ts.isBindingElement(el)) addBinding(el.name);
        }
      };
      const g = (n) => {
        if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) addBinding(n.name);
        ts.forEachChild(n, g);
      };
      ts.forEachChild(node, g);
      return names;
    };

    const walk = (node, inLoop, locals) => {
      let childInLoop = inLoop;
      let childLocals = locals;
      if (isLoopNode(node)) {
        childInLoop = true;
        childLocals = new Set([...locals, ...declaredIn(node)]);
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.getText(sf);
        const recvNode = node.expression.expression;
        // 수신자는 식별자뿐 아니라 프로퍼티 경로도 본다 — this.items / state.list 가
        // NestJS·클래스 코드의 지배적 형태인데 예전엔 통째로 놓치고 있었다.
        // 지역성은 경로의 '루트 식별자'로 판정한다(this는 지역이 아니므로 항상 통과).
        const recvRoot = (e) => {
          let c = e;
          while (ts.isPropertyAccessExpression(c)) c = c.expression;
          if (ts.isIdentifier(c)) return c.getText(sf);
          return c.kind === ts.SyntaxKind.ThisKeyword ? "this" : null;
        };
        const recvIsPath = ts.isIdentifier(recvNode) || ts.isPropertyAccessExpression(recvNode);
        const root = recvIsPath ? recvRoot(recvNode) : null;
        if (inLoop && recvIsPath && root &&
            (QUADRATIC_METHODS.has(method) || QUADRATIC_GROUP_METHODS.has(method))) {
          const recv = recvNode.getText(sf);
          if (!locals.has(root)) {
            sites.push({
              file, line: lineOf(node), recv, method,
              kind: QUADRATIC_GROUP_METHODS.has(method) ? "group" : "lookup",
            });
          }
        }
        // 순회 메서드(map/forEach…)에 넘긴 콜백 본문도 루프로 취급
        if (ITERATING_METHODS.has(method)) {
          for (const arg of node.arguments) {
            if (isFnLike(arg)) walk(arg, true, new Set([...childLocals, ...declaredIn(arg)]));
          }
        }
      }

      ts.forEachChild(node, (child) => {
        const alreadyWalked =
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ITERATING_METHODS.has(node.expression.name.getText(sf)) &&
          isFnLike(child);
        if (!alreadyWalked) walk(child, childInLoop, childLocals);
      });
    };
    ts.forEachChild(sf, (n) => walk(n, false, new Set()));
  }

  const byFile = new Map();
  for (const s of sites) byFile.set(s.file, (byFile.get(s.file) || 0) + 1);
  return {
    sites: sites.length,
    worst: sites.slice(0, 8),
    files: [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, n]) => ({ file, n })),
  };
}

// 교과서 결함 3종 — 정답이 하나뿐이라 외부 기여(PR)로도 안전한 축.
//  ① await in .forEach(): forEach는 콜백의 프라미스를 무시한다 → 기다리지 않는 "진짜 버그".
//  ② 스프레드 누적: 루프/reduce에서 acc = [...acc, x] → 매 회 전체 복사 = O(n²).
//  ③ 루프 안 new RegExp(): 매 회 정규식 재컴파일 → 루프 밖으로 호이스팅.
function analyzeTextbookIssues(ts, fileContents) {
  const awaitInForEach = [];
  const spreadAccumulator = [];
  const regexInLoop = [];
  const floatingPromise = [];
  const statefulRegex = [];
  const forInArray = [];

  for (const { file, content } of fileContents) {
    const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
    const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const isFnLike = (n) =>
      ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
    const isLoopNode = (n) =>
      n.kind === ts.SyntaxKind.ForStatement || n.kind === ts.SyntaxKind.ForInStatement ||
      n.kind === ts.SyntaxKind.ForOfStatement || n.kind === ts.SyntaxKind.WhileStatement ||
      n.kind === ts.SyntaxKind.DoStatement;

    // ── 전역 플래그 정규식 변수 수집: const RE = /x/g  (루프 밖 선언 = lastIndex 상태 공유)
    const globalRegexVars = new Set();
    // ── 배열로 "보이는" 변수 수집: 리터럴/map/filter/Array.from/split 로 만들어진 것만.
    // for...in 은 객체에 쓰는 게 정상이므로, 배열이라는 증거가 있을 때만 잡는다.
    const arrayVars = new Set();
    {
      const ARRAY_MAKERS = new Set(["map", "filter", "flatMap", "slice", "concat", "split", "from", "keys", "values"]);
      const collect = (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          const init = n.initializer;
          if (ts.isRegularExpressionLiteral(init)) {
            const text = init.getText(sf);
            const flags = text.slice(text.lastIndexOf("/") + 1);
            if (flags.includes("g") || flags.includes("y")) globalRegexVars.add(n.name.getText(sf));
          }
          if (ts.isArrayLiteralExpression(init)) arrayVars.add(n.name.getText(sf));
          if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) &&
              ARRAY_MAKERS.has(init.expression.name.getText(sf))) arrayVars.add(n.name.getText(sf));
        }
        ts.forEachChild(n, collect);
      };
      ts.forEachChild(sf, collect);
    }

    // ── A) floating promise 준비: 이 파일에서 선언된 async 함수 이름 수집.
    // 로컬 선언만 본다 — 타입 정보 없이 "프라미스를 반환한다"를 확신할 수 있는 유일한 범위다.
    const asyncNames = new Set();
    {
      const collect = (n) => {
        const isAsync = (node) =>
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
        if (ts.isFunctionDeclaration(n) && isAsync(n) && n.name) asyncNames.add(n.name.getText(sf));
        if (ts.isMethodDeclaration(n) && isAsync(n) && n.name) asyncNames.add(n.name.getText(sf));
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) &&
            (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && isAsync(n.initializer))
          asyncNames.add(n.name.getText(sf));
        if (ts.isPropertyDeclaration(n) && n.initializer && n.name &&
            (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && isAsync(n.initializer))
          asyncNames.add(n.name.getText(sf));
        ts.forEachChild(n, collect);
      };
      ts.forEachChild(sf, collect);
    }

    // 서브트리 안에서 선언된 모든 이름(구조분해 포함)
    const declaredNamesIn = (node) => {
      const names = new Set();
      const addBinding = (name) => {
        if (!name) return;
        if (ts.isIdentifier(name)) { names.add(name.getText(sf)); return; }
        if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
          for (const el of name.elements) if (ts.isBindingElement(el)) addBinding(el.name);
        }
      };
      const g = (n) => {
        if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) addBinding(n.name);
        ts.forEachChild(n, g);
      };
      ts.forEachChild(node, g);
      return names;
    };

    // 콜백 본문에 (중첩 함수 제외) await가 있나
    const hasDirectAwait = (fn) => {
      let found = false;
      const g = (n) => {
        if (found) return;
        if (n !== fn && isFnLike(n)) return;
        if (ts.isAwaitExpression(n)) { found = true; return; }
        ts.forEachChild(n, g);
      };
      ts.forEachChild(fn, g);
      return found;
    };

    // 리터럴이 자기 자신(target)을 스프레드하는가 — [...acc, x] / {...acc, k:v}
    const spreadsSelf = (target, init) => {
      if (!target || !ts.isIdentifier(target)) return false;
      const name = target.getText(sf);
      if (ts.isArrayLiteralExpression(init))
        return init.elements.some((e) => ts.isSpreadElement(e) && ts.isIdentifier(e.expression) && e.expression.getText(sf) === name);
      if (ts.isObjectLiteralExpression(init))
        return init.properties.some((p) => ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression) && p.expression.getText(sf) === name);
      return false;
    };

    const walk = (node, inLoop, inRealLoop, inAsyncFn, loopVars) => {
      let childInLoop = inLoop;
      let childInRealLoop = inRealLoop;
      let childInAsyncFn = inAsyncFn;
      let childLoopVars = loopVars;
      if (isLoopNode(node)) {
        childInLoop = true; childInRealLoop = true;
        // 순회 변수뿐 아니라 루프 '본문에서 선언된 모든 이름'을 지역으로 본다.
        // (루프 안에서 만든 정규식/배열은 매 회 새 객체라 상태가 샐 수 없다)
        childLoopVars = new Set([...loopVars, ...declaredNamesIn(node)]);
      }
      if (isFnLike(node)) {
        childInAsyncFn = !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      }

      // ── 전역 플래그 정규식을 루프 안에서 .test(): lastIndex가 문자열 사이로 새어
      // 같은 입력도 호출마다 결과가 뒤바뀐다. 성능이 아니라 "조용히 틀린 답"을 내는 버그.
      // 고침은 /g 제거 또는 매 회 새 정규식.
      // 가드: .exec()는 제외한다 — `while ((m = re.exec(s)) !== null)` 은 /g 정규식의
      // *정석 순회 관용구*이지 버그가 아니다(실제로 twenty에서 lastIndex=0 리셋까지 하고 있었다).
      if (inLoop && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const m = node.expression.name.getText(sf);
        const recv = node.expression.expression;
        // 가드: 루프 안에서 만든 정규식은 매 회 새 객체라 lastIndex가 샐 수 없다 → 제외
        if (m === "test" && ts.isIdentifier(recv) && globalRegexVars.has(recv.getText(sf)) &&
            !loopVars.has(recv.getText(sf))) {
          statefulRegex.push({ file, line: lineOf(node), name: recv.getText(sf), method: m });
        }
      }

      // ── 배열에 for...in: 인덱스가 문자열이고 상속 속성까지 돌며 순서 보장이 없다.
      // 가드: 배열이라는 증거(리터럴·map·filter·split 등)가 있는 변수만.
      if (ts.isForInStatement(node) && ts.isIdentifier(node.expression) &&
          arrayVars.has(node.expression.getText(sf))) {
        forInArray.push({ file, line: lineOf(node), name: node.expression.getText(sf) });
      }

      // ── A) floating promise: async 함수 안에서, 결과를 버리는 문(ExpressionStatement)으로
      // 로컬 async 함수를 await 없이 호출. 고침은 await 한 단어라 완전히 기계적.
      // 가드: async 컨텍스트 안에서만(밖이면 await를 못 붙여 기계적 수정이 아님),
      //       void/then/catch로 감싼 의도적 fire-and-forget은 구조상 여기 안 걸린다.
      if (inAsyncFn && ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
        const callee = node.expression.expression;
        const name = ts.isIdentifier(callee) ? callee.getText(sf)
          : (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword)
            ? callee.name.getText(sf) : null;
        if (name && asyncNames.has(name)) {
          floatingPromise.push({ file, line: lineOf(node), name });
        }
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.getText(sf);

        if (method === "forEach") {
          for (const arg of node.arguments) {
            if (isFnLike(arg) && hasDirectAwait(arg)) { awaitInForEach.push({ file, line: lineOf(node) }); break; }
          }
        }

        if (method === "reduce") {
          const cb = node.arguments[0];
          if (cb && isFnLike(cb) && cb.parameters.length > 0 && ts.isIdentifier(cb.parameters[0].name)) {
            const acc = cb.parameters[0].name;
            let bad = false;
            const g = (n) => {
              if (bad) return;
              if (n !== cb && isFnLike(n)) return;
              if ((ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)) && spreadsSelf(acc, n)) { bad = true; return; }
              ts.forEachChild(n, g);
            };
            ts.forEachChild(cb, g);
            if (bad) spreadAccumulator.push({ file, line: lineOf(node), where: "reduce" });
          }
        }

        if (ITERATING_METHODS.has(method)) {
          // 순회 콜백은 "루프"지만 진짜 반복문은 아니다 — 모듈 로드 시 1회 도는 map()도 여기 해당.
          for (const arg of node.arguments) if (isFnLike(arg)) walk(arg, true, inRealLoop, childInAsyncFn, new Set([...childLoopVars, ...declaredNamesIn(arg)]));
        }
      }

      if (inLoop && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          spreadsSelf(node.left, node.right)) {
        spreadAccumulator.push({ file, line: lineOf(node), where: "loop" });
      }

      // 진짜 반복문(for/while) 안에서만 — .map()으로 1회 만드는 캐시는 재컴파일이 아니다.
      if (inRealLoop && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.getText(sf) === "RegExp") {
        regexInLoop.push({ file, line: lineOf(node) });
      }

      ts.forEachChild(node, (child) => {
        const alreadyWalked =
          ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ITERATING_METHODS.has(node.expression.name.getText(sf)) && isFnLike(child);
        if (!alreadyWalked) walk(child, childInLoop, childInRealLoop, childInAsyncFn, childLoopVars);
      });
    };
    ts.forEachChild(sf, (n) => walk(n, false, false, false, new Set()));
  }

  return {
    awaitInForEach: { count: awaitInForEach.length, worst: awaitInForEach.slice(0, 6) },
    spreadAccumulator: { count: spreadAccumulator.length, worst: spreadAccumulator.slice(0, 6) },
    regexInLoop: { count: regexInLoop.length, worst: regexInLoop.slice(0, 6) },
    floatingPromise: { count: floatingPromise.length, worst: floatingPromise.slice(0, 6) },
    statefulRegex: { count: statefulRegex.length, worst: statefulRegex.slice(0, 6) },
    forInArray: { count: forInArray.length, worst: forInArray.slice(0, 6) },
  };
}

function analyzeRenderGates(ts, fileContents) {
  const findings = [];

  for (const { file, content } of fileContents) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    // 훅이 물어다 주는 값(로딩이 있는 값)을 찾는다: const { data: x } = useSomething()
    const fetched = new Set();
    const findHookVars = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        /^use[A-Z]/.test(
          ts.isPropertyAccessExpression(n.initializer.expression)
            ? n.initializer.expression.name.getText(sf)
            : n.initializer.expression.getText(sf),
        ) &&
        ts.isObjectBindingPattern(n.name)
      ) {
        for (const el of n.name.elements) {
          const source = (el.propertyName || el.name).getText(sf);
          if (source === "data") fetched.add(el.name.getText(sf));
        }
      }
      ts.forEachChild(n, findHookVars);
    };
    ts.forEachChild(sf, findHookVars);
    if (fetched.size === 0) continue;

    const rootName = (expr) => {
      let cur = expr;
      while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
      return ts.isIdentifier(cur) ? cur.getText(sf) : null;
    };

    /** 이 노드가 그 변수를 실제로 참조하는가 */
    const references = (node, name) => {
      let found = false;
      const scan = (n) => {
        if (found) return;
        if (ts.isIdentifier(n) && n.getText(sf) === name) found = true;
        else ts.forEachChild(n, scan);
      };
      scan(node);
      return found;
    };

    /** 게이트에 쓰인 fetch 변수들 */
    const gateVars = (expr) => {
      const names = new Set();
      const scan = (n) => {
        if (ts.isIdentifier(n) && fetched.has(n.getText(sf))) names.add(n.getText(sf));
        ts.forEachChild(n, scan);
      };
      scan(expr);
      return [...names];
    };

    const inspectGate = (testExpr, element) => {
      const vars = gateVars(testExpr);
      if (vars.length === 0) return;
      const el = ts.isJsxElement(element) ? element.openingElement : element;
      if (!el.attributes) return;
      const props = el.attributes.properties;
      if (props.length < 2) return; // 프롭이 거의 없으면 판단할 근거가 없다

      const dependent = props.filter((p) => vars.some((v) => references(p, v))).length;
      const ratio = dependent / props.length;
      if (ratio < HOSTAGE_DEP_RATIO) {
        findings.push({
          file,
          line: sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1,
          element: el.tagName ? el.tagName.getText(sf) : "?",
          gate: vars.join(", "),
          dependentProps: dependent,
          totalProps: props.length,
        });
      }
    };

    const walk = (n) => {
      // {data && <El .../>}
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        (ts.isJsxElement(n.right) || ts.isJsxSelfClosingElement(n.right))
      ) {
        inspectGate(n.left, n.right);
      }
      // {data ? <El .../> : null}
      if (ts.isConditionalExpression(n) && (ts.isJsxElement(n.whenTrue) || ts.isJsxSelfClosingElement(n.whenTrue))) {
        inspectGate(n.condition, n.whenTrue);
      }
      // 괄호로 감싼 JSX도 같은 취급
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        ts.isParenthesizedExpression(n.right) &&
        (ts.isJsxElement(n.right.expression) || ts.isJsxSelfClosingElement(n.right.expression))
      ) {
        inspectGate(n.left, n.right.expression);
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
    void rootName;
  }

  return {
    hostages: findings.length,
    worst: findings.slice(0, 5),
  };
}

// 파일 분류 — frontend(UI) / backend(API·서버) / shared(공용 유틸)
function classifyFile(filePath, content) {
  const rel = filePath.replace(/\\/g, "/");
  const head = content.slice(0, 300);
  if (
    /\/(api|server)\//.test(rel) ||
    /(^|\/)(route|middleware|instrumentation)\.(ts|js|mjs)$/.test(rel) ||
    /^\s*["']use server["']/.test(head)
  ) {
    return "backend";
  }
  if (/\.(tsx|jsx)$/.test(rel) || /^\s*["']use client["']/.test(head)) {
    return "frontend";
  }
  return "shared";
}

// kit import 감지
function detectKitImports(content) {
  const found = new Set();
  // import { X, Y } from "@m1kapp/kit" 또는 "@m1kapp/kit/..." 패턴
  const importRegex = /import\s*\{([^}]+)\}\s*from\s*["']@m1kapp\/kit(?:\/[^"']*)?["']/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const names = match[1].split(",").map((s) => s.trim().split(" as ")[0].trim());
    for (const name of names) {
      if (name && !name.startsWith("type ")) {
        found.add(name);
      }
    }
  }
  // import type은 제외 — 타입만 쓰는 건 코드 절약 아님
  return found;
}

// 실행
console.log(`\n  분석 중... ${srcDir}\n`);

let files = collectFiles(srcDir);
if (files.length === 0) {
  console.error(`  파일을 찾을 수 없습니다: ${srcDir}`);
  process.exit(1);
}

// git 추적 파일만 분석 (빌드산출물·자동생성·gitignore 제외). git repo 아니면 폴백.
const trackedSet = gitTrackedSet(srcDir);
if (trackedSet) {
  const before = files.length;
  files = files.filter((f) => trackedSet.has(f));
  const removed = before - files.length;
  console.log(`  git 추적 파일만 분석 — 빌드산출물·미추적 ${removed}개 제외 (${files.length}개 대상)\n`);
  if (files.length === 0) {
    console.error(`  git 추적 소스 파일이 없습니다: ${srcDir}`);
    process.exit(1);
  }
} else {
  console.log(`  git repo 아님 — 파일시스템 전체 분석 (빌드산출물 포함될 수 있음)\n`);
}

// 비-프로덕션 파일 일관 제외: 테스트·타입테스트(.test-d)·벤치·스토리·__tests__.
// (중복 축에서만 걸러 다른 축엔 포함되던 불일치 제거 — 테스트 콜로케이션이 점수를 깎던 문제.)
// 청결점수는 "배포되는 프로덕션 코드"의 건강만 잰다. 테스트 존재 여부는 별도 신호.
const NON_SOURCE_RE = /(\.(test|spec|test-d|bench|benchmark|stories|e2e)\.[tj]sx?$)|(\/(__(tests?|mocks?|fixtures?|snapshots?)__|tests?|benchmarks?|__bench__|e2e|fixtures?|mocks?)\/)|(\.d\.ts$)/;
{
  const before = files.length;
  files = files.filter((f) => !NON_SOURCE_RE.test(f.replace(/\\/g, "/")));
  const dropped = before - files.length;
  if (dropped > 0) {
    console.log(`  비-프로덕션 파일(테스트·벤치·스토리·타입선언) ${dropped}개 제외 (${files.length}개 분석)\n`);
  }
}

// 미니파이·번들 파일 제외: 저장소에 커밋된 벤더 번들·시드 에셋은 git 추적 대상이라
// 지금까지의 필터를 전부 통과하지만, 사람이 쓴 코드가 아니라 모든 축을 오염시킨다.
// (실제 사례: 시드 프로젝트의 번들 index.mjs 하나가 for...in 오탐 100곳 이상을 만들었다)
// 판정: 파일명 관례 또는 "한 줄이 비정상적으로 길다"(미니파이의 결정적 특징).
{
  const isMinified = (p) => {
    if (/\.(min|bundle)\.[cm]?js$/.test(p.replace(/\\/g, "/"))) return true;
    try {
      const text = fs.readFileSync(p, "utf-8");
      if (text.length < 500) return false;
      const lines = text.split("\n");
      const longest = lines.reduce((m, l) => (l.length > m ? l.length : m), 0);
      const avg = text.length / lines.length;
      return longest > 2000 || avg > 200;
    } catch {
      return false;
    }
  };
  const before = files.length;
  files = files.filter((f) => !isMinified(f));
  const dropped = before - files.length;
  if (dropped > 0) {
    console.log(`  미니파이·번들 파일 ${dropped}개 제외 — 사람이 쓴 코드가 아님 (${files.length}개 분석)\n`);
  }
}

// 자잘 파일 제외: 코드 5줄 미만은 복잡도·중복 신호가 없고, 빈 파일을 대량으로 넣어
// 비율 분모(파일수·토큰수)를 부풀려 점수를 조작하는 패딩 게이밍을 차단한다.
const TRIVIAL_MIN_CODE = 5;
{
  const before = files.length;
  files = files.filter((f) => {
    try {
      return countLines(fs.readFileSync(f, "utf-8")).code >= TRIVIAL_MIN_CODE;
    } catch {
      return false;
    }
  });
  const dropped = before - files.length;
  if (dropped > 0) {
    console.log(`  자잘 파일(코드 <${TRIVIAL_MIN_CODE}줄) ${dropped}개 제외 — 패딩 게이밍 방지 (${files.length}개 분석)\n`);
  }
}

let totalLines = 0;
let codeLines = 0;
let totalBranches = 0;
let totalFunctions = 0;
let maxFile = { path: "", lines: 0 };
let longFiles = 0; // 200줄 초과 파일 수
let longFileSeverity = 0; // 200→400줄 0→1, 400→600줄 1→2로 완만하게 누적 (600줄+ 파일당 최대 2)
const allImports = new Set();
const ts = loadTypescript();
const allFns = []; // AST 모드: {name, cc, cog, line, file}
const fileContents = []; // 중복 감지용
const breakdown = {
  frontend: { files: 0, codeLines: 0 },
  backend: { files: 0, codeLines: 0 },
  shared: { files: 0, codeLines: 0 },
};

for (const file of files) {
  const content = fs.readFileSync(file, "utf-8");
  const counts = countLines(content);
  totalLines += counts.total;
  codeLines += counts.code;
  const bucket = breakdown[classifyFile(file, content)];
  bucket.files++;
  bucket.codeLines += counts.code;
  const q = analyzeQuality(content);
  totalBranches += q.branches;
  totalFunctions += q.functions;
  if (ts) {
    const rel = path.relative(process.cwd(), file);
    for (const fn of analyzeAstComplexity(ts, file, content)) allFns.push({ ...fn, file: rel });
    fileContents.push({ file: rel, content });
  }
  if (counts.code > maxFile.lines) maxFile = { path: path.relative(process.cwd(), file), lines: counts.code };
  if (counts.code > 200) {
    longFiles++;
    longFileSeverity += Math.min(2, (counts.code - 200) / 200);
  }
  const imports = detectKitImports(content);
  for (const imp of imports) allImports.add(imp);
}

const branchDensity = codeLines > 0 ? Math.round((totalBranches / codeLines) * 1000) / 10 : 0;
const avgFileLines = files.length > 0 ? Math.round(codeLines / files.length) : 0;

// 청결도 스코어 v2 (100점 만점)
// AST 모드: cognitive complexity(중첩 가중, SonarQube 함수당 15 권고) + 중복 밀도(SonarQube 3% 게이트)
// 프로젝트 크기 편향 없게 비율 기반 감점:
// - cog>15 함수 비율 ×3 (최대 25), cog>25 함수 비율 ×5 (최대 15)
// - 최악 함수: cog 20 초과분 ×1 (최대 15)
// - 중복 밀도: 3% 초과분 ×2.5 (최대 25) ← 새 축
// - 200줄 초과 파일: 초과분에 비례한 심각도(200→400줄 0→1, 400→600줄 1→2, 600줄+ 캡) 비율 ×1.5 (최대 10)
//   ※ 파일 개수 기준 이진 카운트(200줄 넘으면 무조건 1) 대신 심각도 가중 — 살짝 넘는 파일과
//     터무니없이 큰 파일을 구분하고, 파일 수 적은 프로젝트가 파일 1개만으로 즉시 만점 감점 맞는 절벽 방지.
// / 평균 파일 길이 80줄 초과분 /5 (최대 10)
// - 렌더 인질(fetch 하나가 무관한 UI까지 막는 자리) ×3 (최대 10)
// - 루프 안 무캐시 파일읽기 사이트 ×4 (최대 20) ← 새 축. 코드 모양이 아무리 깔끔해도
//   호출 1번이 파일 N번을 읽는 구조는 여기서만 드러난다(cognitive·중복으론 원리상 안 잡힘).
let qualityScore;
let cc = null;
let cognitive = null;
let duplication = null;
let io = null;
let renderGates = null;
let quadratic = null;
let textbook = null;
if (ts && allFns.length > 0) {
  const byCc = [...allFns].sort((a, b) => b.cc - a.cc);
  cc = {
    functions: allFns.length,
    avg: Math.round((allFns.reduce((s, f) => s + f.cc, 0) / allFns.length) * 10) / 10,
    p90: byCc[Math.floor((byCc.length - 1) * 0.1)].cc,
    max: byCc[0].cc,
    over10: byCc.filter((f) => f.cc > 10).length,
    over20: byCc.filter((f) => f.cc > 20).length,
    worst: byCc.slice(0, 5).map(({ name, cc, file, line }) => ({ name, cc, file, line })),
  };

  const byCog = [...allFns].sort((a, b) => b.cog - a.cog);
  const cogOver15 = byCog.filter((f) => f.cog > 15);
  const cogOver25 = byCog.filter((f) => f.cog > 25);
  const maxCog = byCog[0].cog;
  cognitive = {
    avg: Math.round((allFns.reduce((s, f) => s + f.cog, 0) / allFns.length) * 10) / 10,
    p90: byCog[Math.floor((byCog.length - 1) * 0.1)].cog,
    max: maxCog,
    over15: cogOver15.length,
    over25: cogOver25.length,
    worst: byCog.slice(0, 5).map(({ name, cog, cc, file, line }) => ({ name, cog, cc, file, line })),
  };

  duplication = analyzeDuplication(ts, fileContents);
  io = analyzeIoDensity(ts, fileContents);
  renderGates = analyzeRenderGates(ts, fileContents);
  quadratic = analyzeQuadraticLookups(ts, fileContents);
  textbook = analyzeTextbookIssues(ts, fileContents);

  // v4 보정: 존경받는 OSS 코퍼스(ky·execa·zod·hono·vite·zustand 등 14종) 분포로 역피팅.
  // 원칙: 건강한 코드베이스도 함수 몇%는 cog15+·중복 약간은 정상 → free 임계 이하 감점 0,
  //       극소 repo가 비율 폭주로 D 맞지 않게 함수 수 하한(floor) 적용, 캡 합 90으로 포화 축소.
  // 스케일 정규화: 절대개수(io·renderGates·maxCog)는 비율/로그로 — 대형이 개수만으로 만렙 맞던 것 해소.
  const SCORE_FN_FLOOR = 40; // 극소 repo 안정화 — 함수 1개 복잡해도 33%가 되지 않게
  const fnDenom = Math.max(allFns.length, SCORE_FN_FLOOR);
  const over15Pct = (cogOver15.length / fnDenom) * 100;
  const over25Pct = (cogOver25.length / fnDenom) * 100;
  const longFileSeverityPct = (longFileSeverity / files.length) * 100;
  // io = 루프 안 파일읽기 + DB/HTTP N+1(순차 await). 파일당 비율.
  // renderGates(렌더 인질)는 실측상 존경 OSS 17종서 0회 발동 = 변별력 없어 점수에서 제외.
  // (진단 출력·JSON엔 유지 — React 앱에서 참고용.)
  qualityScore = Math.max(0, Math.round(
    100
    - Math.min(15, Math.max(0, over15Pct - 2) * 2)  // cog15+ 함수비율 (2% 초과분만)
    - Math.min(12, Math.max(0, over25Pct - 1) * 3)  // cog25+ 함수비율 (1% 초과분만)
    - Math.min(12, Math.max(0, Math.log2(Math.max(1, maxCog) / 15)) * 1.5) // 최악 함수: 로그(계수를 낮춰 100~800 구간이 갈리게 — 캡만 키우면 전부 만렙이라 변별력이 없다)
    - Math.min(16, Math.max(0, duplication.percent - 8) * 1.2) // 중복: 8% 초과분(구조적 반복 관용)
    - Math.min(10, longFileSeverityPct * 1.0)       // 200줄+ 파일 심각도
    - Math.min(12, Math.max(0, avgFileLines - 120) / 6) // 평균 파일 길이 120줄 초과분
    // io(루프 IO·N+1)는 점수에서 뺐다: 재시도 루프·커서 페이지네이션처럼 '순차가 필수'인
    // 코드를 구분하려면 사람 검증이 필요한데(PATTERNS.md), 사람이 필요한 축을 자동 채점에
    // 넣으면 작은 저장소가 통째로 무너진다(파일 1개·사이트 2곳 = 만렙 감점). 진단으로만 보고한다.
  ));
} else {
  // regex 폴백 (typescript 미설치)
  qualityScore = Math.max(0, Math.round(
    100
    - Math.min(40, Math.max(0, branchDensity - 10) * 2)
    - Math.min(30, longFileSeverity * 2.5)
    - Math.min(30, Math.max(0, avgFileLines - 80) / 4)
  ));
}
// 데드코드축 (--dead) — knip 결과를 점수에 반영. @keep 파일은 제외됨.
// 표준 도구(Sonar·CodeClimate)가 안 재는 축: 죽은 파일·export 비율.
let dead = null;
if (wantDead) {
  dead = analyzeDeadCode(srcDir, new Set(files));
  if (dead) {
    const deadFilePct = files.length > 0 ? (dead.deadFiles / files.length) * 100 : 0;
    // 파일당 미사용 export 수 — 예전엔 함수 수로 나눠 단위가 맞지 않았다(타입 위주 패키지에서 무의미)
    const deadExportPct = files.length > 0 ? (dead.unusedExports / files.length) * 100 : 0;
    const deadPenalty = Math.min(20, deadFilePct * 1.0) + Math.min(10, deadExportPct * 0.3);
    dead.filePct = Math.round(deadFilePct * 10) / 10;
    dead.exportPct = Math.round(deadExportPct * 10) / 10;
    dead.penalty = Math.round(deadPenalty * 10) / 10;
    qualityScore = Math.max(0, Math.round(qualityScore - deadPenalty));
  }
}
const qualityGrade = qualityScore >= 90 ? "A+" : qualityScore >= 80 ? "A" : qualityScore >= 70 ? "B" : qualityScore >= 60 ? "C" : "D";

// 절약량 계산
// 같은 소스 파일에서 여러 export를 쓰더라도 파일 LOC는 한 번만 카운트
const usedFeatures = [];
let savedLines = 0;
const usedByCategory = { component: 0, hook: 0, util: 0 };
const countedSources = new Set();

for (const name of allImports) {
  const meta = KIT_FEATURES[name];
  if (!meta) continue;

  // 카테고리별 사용 수 (loc 0이어도 카운트 — "Tab"도 사용한 거니까)
  usedByCategory[meta.category] = (usedByCategory[meta.category] || 0) + 1;

  // LOC 절약은 소스 파일 단위로 1번만. 대표(loc>0)만 카운트하므로 import
  // 순서와 무관 — 비대표(loc 0)가 먼저 와도 source를 선점하지 않는다.
  if (meta.loc > 0 && !(meta.source && countedSources.has(meta.source))) {
    if (meta.source) countedSources.add(meta.source);
    usedFeatures.push({ name, loc: meta.loc, category: meta.category });
    savedLines += meta.loc;
  }
}

const estimatedKB = Math.round(savedLines * 40 / 1024);
const estimatedA4 = Math.round(savedLines / 80);
const savedPercent = codeLines > 0 ? Math.round((savedLines / (codeLines + savedLines)) * 100) : 0;

// 사용률: kit이 제공하는 전체 요소 중 몇 개를 쓰고 있는지
const usage = {
  component: { used: usedByCategory.component, total: kitTotalFeatures.component, percent: kitTotalFeatures.component > 0 ? Math.round((usedByCategory.component / kitTotalFeatures.component) * 100) : 0 },
  hook: { used: usedByCategory.hook, total: kitTotalFeatures.hook, percent: kitTotalFeatures.hook > 0 ? Math.round((usedByCategory.hook / kitTotalFeatures.hook) * 100) : 0 },
  util: { used: usedByCategory.util, total: kitTotalFeatures.util, percent: kitTotalFeatures.util > 0 ? Math.round((usedByCategory.util / kitTotalFeatures.util) * 100) : 0 },
};

const stats = {
  generatedAt: new Date().toISOString(),
  kitVersion,
  source: {
    dir: path.relative(process.cwd(), srcDir),
    files: files.length,
    totalLines,
    codeLines,
    breakdown, // frontend(UI) / backend(API·서버) / shared(공용) 별 files·codeLines
  },
  quality: {
    engine: cc ? "ast2" : "regex", // ast2 = cognitive complexity + 중복 감지
    score: qualityScore,
    grade: qualityGrade,
    dead,                 // {deadFiles, keptFiles, unusedExports, filePct, exportPct, penalty, worst[]} — knip(@keep 제외), --dead 시만
    cognitive,            // {avg, p90, max, over15, over25, worst[5]} — 중첩 가중 복잡도
    duplication,          // {percent, blocks, worstFiles, worstBlocks} — 토큰 중복 밀도
    io,                   // {readers, uncachedReaders, loopSites, uncachedLoopSites, worst} — 루프 안 파일 읽기
    textbook,             // {awaitInForEach, spreadAccumulator, regexInLoop} — 교과서 결함(진단 전용)
    quadratic,            // {sites, worst[], files[]} — 루프 안 O(n²) 배열 조회(진단 전용, 점수 미반영)
    renderGates,          // {hostages, worst} — fetch 하나가 무관한 UI까지 막고 있는 자리
    cc,                   // {functions, avg, p90, max, over10, over20, worst[5]} — McCabe (참고용)
    branchDensity,        // 100줄당 분기 수 (regex 근사, 참고용)
    branches: totalBranches,
    functions: totalFunctions,
    avgFileLines,
    longFiles,            // 200줄 초과 파일 수
    maxFile,
  },
  kit: {
    features: usedFeatures.sort((a, b) => b.loc - a.loc),
    savedLines,
    savedKB: estimatedKB,
    savedA4: estimatedA4,
    savedPercent,
    usage,
  },
};

// 출력
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "kit-stats.json");
fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));

// --badge: README·사이트에 붙일 SVG 배지 + 마크다운 스니펫
if (wantBadge) {
  const badgePath = path.join(outDir, "cleanscore.svg");
  fs.writeFileSync(badgePath, makeBadgeSvg(qualityGrade, qualityScore));
  const rel = path.relative(process.cwd(), badgePath);
  console.log(`\n  🏷  배지 생성: ${rel}`);
  console.log(`     README에 붙이기:  ![clean score](${rel})`);
}

console.log(`  파일: ${files.length}개`);
console.log(`  코드: ${codeLines.toLocaleString()}줄 (전체 ${totalLines.toLocaleString()}줄)`);
console.log(`    프론트: ${breakdown.frontend.files}개 파일, ${breakdown.frontend.codeLines.toLocaleString()}줄`);
console.log(`    백엔드: ${breakdown.backend.files}개 파일, ${breakdown.backend.codeLines.toLocaleString()}줄`);
console.log(`    공용: ${breakdown.shared.files}개 파일, ${breakdown.shared.codeLines.toLocaleString()}줄`);
// kit 활용도/절약량은 @m1kapp/kit meta.json이 있을 때만 (선택적 부가정보) — 없으면 청결점수만.
if (hasKitMeta) {
  console.log(`  kit 사용: ${usedFeatures.length}개 요소`);
  console.log(`    컴포넌트: ${usage.component.used}/${usage.component.total}개 (${usage.component.percent}%)`);
  console.log(`    훅: ${usage.hook.used}/${usage.hook.total}개 (${usage.hook.percent}%)`);
  console.log(`    유틸리티: ${usage.util.used}/${usage.util.total}개 (${usage.util.percent}%)`);
  console.log(`  절약량: 약 ${savedLines.toLocaleString()}줄, ${estimatedKB}KB (A4 ${estimatedA4}장)`);
  console.log(`  비율: 전체의 약 ${savedPercent}%를 kit이 대신 처리`);
}
if (cc) {
  console.log(`  청결도: ${qualityGrade} (${qualityScore}점) — 함수 ${cc.functions}개, cognitive 평균 ${cognitive.avg}·최대 ${cognitive.max}, cog15+ ${cognitive.over15}개·cog25+ ${cognitive.over25}개, 중복 ${duplication.percent}%, 200줄+ ${longFiles}개`);
  for (const w of cognitive.worst.filter((f) => f.cog > 15)) {
    console.log(`    복잡: ${w.name} cog ${w.cog} (CC ${w.cc}) — ${w.file}:${w.line}`);
  }
  if (duplication.percent > 3) {
    console.log(`  중복 상위 파일: ${duplication.worstFiles.map((f) => `${f.file}(${f.dupTokens}tok)`).join(", ")}`);
    for (const ex of duplication.worstBlocks) {
      console.log(`    중복 블록: ${ex.join(" ≒ ")}`);
    }
  }
  if (renderGates.hostages > 0) {
    console.log(`  렌더 인질: ${renderGates.hostages}곳 — 데이터를 기다리느라 이미 아는 UI까지 못 그립니다`);
    for (const w of renderGates.worst) {
      console.log(`    인질: <${w.element}> ${w.gate} 대기 (의존 프롭 ${w.dependentProps}/${w.totalProps}) — ${w.file}:${w.line}`);
    }
  }
  if (io.uncachedLoopSites > 0) {
    console.log(`  루프 안 파일읽기: ${io.uncachedLoopSites}곳 (캐시 없는 리더 ${io.uncachedReaders}/${io.readers}개) — 호출 1번이 파일 N번 읽습니다`);
    for (const w of io.worst) {
      console.log(`    반복 읽기: ${w.callee}() — ${w.file}:${w.line}`);
    }
  }
} else {
  console.log(`  청결도: ${qualityGrade} (${qualityScore}점) — 분기밀도 ${branchDensity}/100줄, 평균 ${avgFileLines}줄/파일, 200줄+ ${longFiles}개 (regex 폴백 — typescript 설치 시 AST 정밀 분석)`);
}
if (textbook) {
  const t = textbook;
  if (t.awaitInForEach.count > 0) {
    console.log(`  ⚠ await in forEach: ${t.awaitInForEach.count}곳 — forEach는 프라미스를 무시합니다 (기다리지 않는 버그, for...of 또는 Promise.all)`);
    for (const w of t.awaitInForEach.worst) console.log(`    ${w.file}:${w.line}`);
  }
  if (t.spreadAccumulator.count > 0) {
    console.log(`  스프레드 누적: ${t.spreadAccumulator.count}곳 — acc = [...acc, x] 는 매 회 전체 복사 O(n²) (push/직접 대입)`);
    for (const w of t.spreadAccumulator.worst) console.log(`    (${w.where}) ${w.file}:${w.line}`);
  }
  if (t.statefulRegex.count > 0) {
    console.log(`  ⚠ 전역 정규식 상태: ${t.statefulRegex.count}곳 — /g 정규식을 루프에서 .test() 하면 lastIndex가 문자열 사이로 새어 결과가 번갈아 틀립니다`);
    for (const w of t.statefulRegex.worst) console.log(`    ${w.name}.${w.method}() — ${w.file}:${w.line}`);
  }
  if (t.forInArray.count > 0) {
    console.log(`  ⚠ 배열에 for...in: ${t.forInArray.count}곳 — 인덱스가 문자열이고 상속 속성까지 돕니다 (for...of 권장)`);
    for (const w of t.forInArray.worst) console.log(`    ${w.name} — ${w.file}:${w.line}`);
  }
  if (t.floatingPromise.count > 0) {
    console.log(`  ⚠ floating promise: ${t.floatingPromise.count}곳 — async 함수를 await 없이 호출하고 결과를 버립니다 (기다리지 않는 버그)`);
    for (const w of t.floatingPromise.worst) console.log(`    ${w.name}() — ${w.file}:${w.line}`);
  }
  if (t.regexInLoop.count > 0) {
    console.log(`  루프 안 new RegExp: ${t.regexInLoop.count}곳 — 매 회 재컴파일 (루프 밖으로 호이스팅)`);
    for (const w of t.regexInLoop.worst) console.log(`    ${w.file}:${w.line}`);
  }
}
if (quadratic && quadratic.sites > 0) {
  console.log(`  O(n²) 배열 조회: ${quadratic.sites}곳 — 루프 안에서 루프 밖 배열을 선형 탐색합니다 (Map/Set으로 O(n), 점수 미반영)`);
  for (const w of quadratic.worst.slice(0, 5)) {
    console.log(`    ${w.recv}.${w.method}() — ${w.file}:${w.line}`);
  }
}
if (dead) {
  console.log(`  데드코드: 죽은 파일 ${dead.deadFiles}개(${dead.filePct}%)·미사용 export ${dead.unusedExports}개(${dead.exportPct}%) → 감점 −${dead.penalty}${dead.keptFiles > 0 ? ` · @keep 제외 ${dead.keptFiles}개` : ""}`);
  for (const f of dead.worst) console.log(`    죽음: ${f}`);
}
// ── (선택) LLM 자문 — 정적 지표가 못 보는 네이밍·응집도. 점수엔 미반영, 자문만 ──
if (args.includes("--llm") && cognitive) {
  try {
    console.log(`  LLM 자문 요청 중... (claude haiku)`);
    // cognitive 최악 3개 함수 소스 발췌 (각 최대 60줄)
    const snippets = cognitive.worst.slice(0, 3).map((w) => {
      const abs = path.resolve(process.cwd(), w.file);
      const src = fs.readFileSync(abs, "utf-8").split("\n");
      const from = Math.max(0, w.line - 1);
      return `// ${w.file}:${w.line} — ${w.name} (cognitive ${w.cog})\n` + src.slice(from, from + 60).join("\n");
    }).join("\n\n---\n\n");

    const prompt = `다음은 한 프로젝트에서 cognitive complexity가 가장 높은 함수들이다. 정적 지표로 못 보는 관점만 평가하라: 네이밍 명확성, 함수 응집도(한 가지 일만 하는가), 본질적 복잡성인지 정리 가능한 복잡성인지. 반드시 아래 JSON 한 줄로만 답하라:
{"naming": 0-100, "cohesion": 0-100, "essential": true|false, "advice": "한국어 한 문장"}

${snippets}`;

    const out = execFileSync("claude", ["-p", prompt, "--model", "haiku"], {
      encoding: "utf-8",
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
    // 중첩 없는 JSON 오브젝트 후보들 중 파싱되는 첫 번째 사용
    const candidates = out.match(/\{[^{}]*\}/g) || [];
    let llm = null;
    for (const c of candidates) {
      try { llm = JSON.parse(c); break; } catch { /* 다음 후보 */ }
    }
    if (llm) {
      stats.quality.llm = { model: "haiku", ...llm };
      fs.writeFileSync(outPath, JSON.stringify(stats, null, 2));
      console.log(`  LLM 자문: 네이밍 ${llm.naming} · 응집도 ${llm.cohesion} · 본질적 복잡성 ${llm.essential ? "예" : "아니오"}`);
      console.log(`    → ${llm.advice}`);
    }
  } catch (e) {
    console.log(`  LLM 자문 실패 (claude CLI 필요): ${e.message?.slice(0, 60)}`);
  }
}

console.log(`\n  저장됨 → ${path.relative(process.cwd(), outPath)}\n`);
