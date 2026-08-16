import YAML from "yaml";

export function parsePatchYaml(text: string): any[] {
  if (!text.trim()) return [];
  const parsed = YAML.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed === undefined || parsed === null) return [];
  return [parsed];
}

export function stringifyPatchYaml(entries: any[]): string {
  if (entries.length === 0) return "# dsh profile root\n[]\n";
  return YAML.stringify(entries, { lineWidth: 0 });
}

export function parseYamlFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  try {
    const parsed = YAML.parse(match[1]) as Record<string, unknown>;
    return { frontmatter: parsed && typeof parsed === "object" ? parsed : {}, body: match[2] };
  } catch {
    return { frontmatter: {}, body: text };
  }
}

export function stringifyYamlFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const header = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${header}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}
