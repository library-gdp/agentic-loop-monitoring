/**
 * 직전 정식 릴리스(SNAPSHOT이 아닌 태그) 이후의 커밋에서 패치노트를 만듭니다.
 * Conventional Commits의 feat, fix, perf와 호환성이 깨지는 변경만 적습니다.
 *
 * 사용법: bun scripts/release-notes.ts <tag>
 */

const tag = process.argv[2];
if (!tag) throw new Error("usage: bun scripts/release-notes.ts <tag>");

const CATEGORIES = [
  { label: "호환성 변경", match: (_type: string, breaking: boolean) => breaking },
  { label: "추가", match: (type: string) => type === "feat" },
  { label: "수정", match: (type: string) => type === "fix" },
  { label: "성능", match: (type: string) => type === "perf" },
];

function git(...args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args]);
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
}

function previousRelease(): string | undefined {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname").out.split("\n");
  return tags.find(
    (candidate) =>
      candidate !== "" &&
      candidate !== tag &&
      !candidate.endsWith("-SNAPSHOT") &&
      git("merge-base", "--is-ancestor", candidate, "HEAD").ok,
  );
}

const base = previousRelease();
const range = base ? `${base}..HEAD` : "HEAD";
const log = git("log", "--no-merges", "--format=%s%x1f%b%x1e", range).out;

const items = new Map<string, Set<string>>(CATEGORIES.map(({ label }) => [label, new Set()]));
for (const entry of log.split("\x1e")) {
  const [subject = "", body = ""] = entry.trim().split("\x1f");
  const parsed = /^(\w+)(?:\([^)]*\))?(!)?: (.+)$/.exec(subject);
  if (!parsed) continue;
  const [, type = "", bang, description = ""] = parsed;
  const breaking = bang === "!" || /^BREAKING[ -]CHANGE:/m.test(body);
  const category = CATEGORIES.find(({ match }) => match(type, breaking));
  if (category) items.get(category.label)?.add(description);
}

const lines = [...items].flatMap(([label, descriptions]) =>
  [...descriptions].map((description) => `- ${label}: ${description}`),
);
console.log(lines.length > 0 ? lines.join("\n") : "- 기능 변경 없음");
