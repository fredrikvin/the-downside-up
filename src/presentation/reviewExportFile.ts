import { basename, isAbsolute, join, relative, sep } from "node:path";

export interface ReviewExportNameInput {
  /** The repository root; only its folder name is used. */
  readonly root: string;
  readonly kind: "working" | "commit";
  /** A base commit or, without one, the review's own base label. */
  readonly base: string;
  readonly commit?: string;
  readonly date: Date;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const slug = (value: string, fallback: string): string =>
  value.normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    .replace(/[-.]+$/g, "") || fallback;

/** `review-<repo>-<base or commit>-<YYYY-MM-DD>.md`, with a local date and file-name-safe parts. */
export function reviewExportFileName(input: ReviewExportNameInput): string {
  const target = input.kind === "commit" && input.commit ? input.commit.slice(0, 7)
    : OBJECT_ID.test(input.base) ? input.base.slice(0, 7)
    : input.base;
  const day = [
    input.date.getFullYear(),
    String(input.date.getMonth() + 1).padStart(2, "0"),
    String(input.date.getDate()).padStart(2, "0")
  ].join("-");
  return `review-${slug(basename(input.root), "repository")}-${slug(target, "changes")}-${day}.md`;
}

/** Whether `path` is `folder` itself or anywhere below it. Both should already be resolved. */
export function isInsideFolder(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The last folder an export was saved to, else Downloads, else the home folder. */
export async function defaultReviewExportFolder(
  lastFolder: string | undefined,
  home: string,
  isFolder: (path: string) => Promise<boolean>
): Promise<string> {
  if (lastFolder && await isFolder(lastFolder)) return lastFolder;
  const downloads = join(home, "Downloads");
  return await isFolder(downloads) ? downloads : home;
}
