import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("extension settings", () => {
  it("declares every downsideUp setting the code reads or writes", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
    const used = new Set<string>();
    const pattern = /(?:\bsettings|getConfiguration\("downsideUp"\))\.(?:get|update)(?:<[^>]*>)?\(\s*"([^"]+)"/g;
    for (const file of sources(resolve("src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) used.add(`downsideUp.${match[1]}`);
    }
    for (const match of readFileSync(resolve("src/extension.ts"), "utf8").matchAll(/affectsConfiguration\("(downsideUp\.[^"]+)"\)/g)) {
      if (!declared.has(match[1]!)) {
        expect([...declared].some((key) => key.startsWith(`${match[1]}.`)), `${match[1]} matches a declared setting`).toBe(true);
      }
    }
    expect(used.size).toBeGreaterThan(8);
    expect([...used].filter((key) => !declared.has(key))).toEqual([]);
  });

  it("keeps exclusion policy settings user-level, so a repository cannot change them", () => {
    const properties = JSON.parse(readFileSync(resolve("package.json"), "utf8")).contributes.configuration.properties;
    const policy = readFileSync(resolve("src/context/policy.ts"), "utf8");
    const keys = [...policy.matchAll(/"(exclusion\.[A-Za-z]+)"/g)].map((match) => `downsideUp.${match[1]}`);
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(properties[key]?.scope, key).toBe("application");
  });
});
