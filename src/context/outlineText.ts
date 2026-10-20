/** A run of description text; `code` runs render in a monospace font. */
export interface TextSegment {
  readonly text: string;
  readonly code?: true;
  /** Local outline qualified name; resolved to a host-owned reference before rendering. */
  readonly target?: string;
  readonly referenceId?: string;
}

export type Description = readonly TextSegment[];

const MAX_CODE_LENGTH = 80;

/** Collapses whitespace in a source excerpt and bounds its length for inline display. */
export function excerpt(source: string, maxLength = MAX_CODE_LENGTH): string {
  const compact = source
    .replace(/\s*\n\s*(?=[.?)\]}])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1).trimEnd()}…` : compact;
}

export class DescriptionBuilder {
  private readonly segments: TextSegment[] = [];

  text(value: string): this {
    if (!value) return this;
    const last = this.segments[this.segments.length - 1];
    if (last && !last.code) this.segments[this.segments.length - 1] = { text: last.text + value };
    else this.segments.push({ text: value });
    return this;
  }

  code(value: string): this {
    const bounded = excerpt(value);
    if (bounded) this.segments.push({ text: bounded, code: true });
    return this;
  }

  /** Appends items as an English list: "a", "a and b", "a, b, and c". */
  list<T>(items: readonly T[], write: (builder: this, item: T) => void, limit = 10): this {
    const shown = items.slice(0, limit);
    const hidden = items.length - shown.length;
    shown.forEach((item, index) => {
      if (index > 0) {
        const last = index === shown.length - 1 && hidden === 0;
        this.text(last ? (shown.length > 2 ? ", and " : " and ") : ", ");
      }
      write(this, item);
    });
    if (hidden > 0) this.text(`, and ${hidden} more`);
    return this;
  }

  append(description: Description): this {
    for (const segment of description) {
      if (segment.code) this.segments.push(segment);
      else this.text(segment.text);
    }
    return this;
  }

  build(): Description {
    return [...this.segments];
  }
}

export function describe(): DescriptionBuilder {
  return new DescriptionBuilder();
}

/** Joins clauses as "a", "a and b", or "a, b, and c" into one description. */
export function clauses(parts: readonly Description[]): Description {
  const builder = describe();
  builder.list(parts, (target, part) => target.append(part), parts.length);
  return builder.build();
}

export function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
