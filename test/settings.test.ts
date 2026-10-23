import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every declared setting, from all settings sections. */
function declaredSettings(): Record<string, { scope?: string; default?: unknown }> {
  const configuration = JSON.parse(readFileSync(resolve("package.json"), "utf8")).contributes.configuration;
  const sections: Array<{ properties: Record<string, { scope?: string }> }> = Array.isArray(configuration) ? configuration : [configuration];
  return Object.assign({}, ...sections.map((section) => section.properties));
}

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("extension settings", () => {
  it("declares a bounded user-only project context budget", () => {
    expect(declaredSettings()["downsideUp.maxProjectContextRequestSize"]).toMatchObject({
      type: "integer", scope: "application", default: 256, minimum: 128, maximum: 1024
    });
    const extension = readFileSync(resolve("src/extension.ts"), "utf8");
    expect(extension).toContain('inspect<number>("maxProjectContextRequestSize")?.globalValue');
  });

  it("enables explanation formats by default while keeping prefetch opt-in", () => {
    const properties = declaredSettings();
    expect(properties["downsideUp.explanations.formats"]?.default).toEqual({
      pseudocode: true,
      flowchart: true
    });
    expect(properties["downsideUp.explanations.initialFormat"]?.default).toBe("steps");
    expect(properties["downsideUp.prefetch.enabled"]?.default).toBe(false);
    expect(properties["downsideUp.prefetch.enabled"]?.scope).toBe("application");
  });

  it("declares every downsideUp setting the code reads or writes", () => {
    const declared = new Set(Object.keys(declaredSettings()));
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
    const properties = declaredSettings();
    const policy = readFileSync(resolve("src/context/policy.ts"), "utf8");
    const keys = [...policy.matchAll(/"(exclusion\.[A-Za-z]+)"/g)].map((match) => `downsideUp.${match[1]}`);
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(properties[key]?.scope, key).toBe("application");
  });

  it("groups the model settings by provider", () => {
    const configuration = JSON.parse(readFileSync(resolve("package.json"), "utf8")).contributes.configuration;
    const section = (title: string) => Object.keys(configuration.find((entry: { title: string }) => entry.title === title)?.properties ?? {});
    expect(section("VS Code Language Models")).toEqual([
      "downsideUp.languageModel.model",
      "downsideUp.languageModel.overviewModel"
    ]);
    expect(section("OpenAI")).toEqual(["downsideUp.openai.model", "downsideUp.openai.overviewModel"]);
  });

  it("links every exclusion path to its file picker and the shared folder picker", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const properties = Object.assign({}, ...manifest.contributes.configuration.map((section: { properties: object }) => section.properties));
    const extension = readFileSync(resolve("src/extension.ts"), "utf8");
    const commands = new Set(manifest.contributes.commands.map((command: { command: string }) => command.command));
    for (const [setting, command] of [
      ["blockedFilePatternsFile", "chooseBlockedFilePatternsFile"],
      ["restrictedRemotesFile", "chooseRestrictedRemotesFile"],
      ["allowedRepositoriesFile", "chooseAllowedRepositoriesFile"]
    ]) {
      const description = properties[`downsideUp.exclusion.${setting}`].markdownDescription;
      expect(description).toContain(`command:downsideUp.${command}`);
      expect(description).toContain("command:downsideUp.chooseExclusionFolder");
      expect(description).toContain("command:downsideUp.checkContentExclusions");
      expect(commands.has(`downsideUp.${command}`)).toBe(true);
      expect(extension).toContain(`registerCommand("downsideUp.${command}"`);
    }
    expect(commands.has("downsideUp.chooseExclusionFolder")).toBe(true);
    expect(extension).toContain('registerCommand("downsideUp.chooseExclusionFolder"');
    expect(commands.has("downsideUp.checkContentExclusions")).toBe(true);
    expect(extension).toContain('registerCommand("downsideUp.checkContentExclusions"');
  });
});
