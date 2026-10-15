export class Position {
  constructor(public readonly line: number, public readonly character: number) {}

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startLine: number | Position,
    startCharacter: number | Position,
    endLine?: number,
    endCharacter?: number
  ) {
    if (startLine instanceof Position && startCharacter instanceof Position) {
      this.start = startLine;
      this.end = startCharacter;
    } else {
      this.start = new Position(startLine as number, startCharacter as number);
      this.end = new Position(endLine ?? (startLine as number), endCharacter ?? (startCharacter as number));
    }
  }

  contains(position: Position): boolean {
    return !position.isBefore(this.start) && this.end.line >= position.line &&
      (this.end.line !== position.line || this.end.character >= position.character);
  }

  isEqual(other: Range): boolean {
    return this.start.line === other.start.line &&
      this.start.character === other.start.character &&
      this.end.line === other.end.line &&
      this.end.character === other.end.character;
  }
}

export class DocumentSymbol {
  constructor(
    public readonly name: string,
    public readonly detail: string,
    public readonly kind: number,
    public readonly range: Range,
    public readonly selectionRange: Range,
    public readonly children: DocumentSymbol[] = []
  ) {}
}

export const SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25
};

export const workspace = {
  textDocuments: [] as Array<{ uri: { scheme: string; fsPath: string }; isDirty?: boolean; getText(): string }>,
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        return vscodeConfiguration.get(`${section ?? ""}.${key}`) as T | undefined ?? fallback;
      },
      /** Configured test values count as user settings. */
      inspect<T>(key: string): { globalValue?: T; workspaceValue?: T } | undefined {
        const workspaceValue = vscodeConfiguration.get(`workspace:${section ?? ""}.${key}`) as T | undefined;
        return {
          globalValue: vscodeConfiguration.get(`${section ?? ""}.${key}`) as T | undefined,
          ...(workspaceValue === undefined ? {} : { workspaceValue })
        };
      }
    };
  },
  openTextDocument: async (uri: { fsPath: string }): Promise<unknown> => {
    throw new Error(`No test document for ${uri.fsPath}`);
  },
  __setConfiguration(key: string, value: unknown) {
    vscodeConfiguration.set(key, value);
  },
  __resetConfiguration() {
    vscodeConfiguration.clear();
    workspace.textDocuments = [];
  }
};

const vscodeConfiguration = new Map<string, unknown>();

export const Uri = {
  file(fsPath: string) {
    return {
      fsPath,
      path: fsPath,
      scheme: "file",
      toString: () => `file://${fsPath}`
    };
  }
};

export const extensions = {
  getExtension(_id: string): { activate(): Promise<void> } | undefined {
    return undefined;
  }
};

export const commands = {
  execute: async (..._args: unknown[]): Promise<unknown> => [],
  async executeCommand(...args: unknown[]): Promise<unknown> {
    return commands.execute(...args);
  },
  __setExecuteCommand(execute: (...args: unknown[]) => Promise<unknown>) {
    commands.execute = execute;
  }
};

export class CancellationTokenSource {
  private readonly listeners = new Set<() => void>();
  private cancelled = false;
  readonly token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
  };

  constructor() {
    const listeners = this.listeners;
    const isCancelled = () => this.cancelled;
    this.token = {
      get isCancellationRequested() {
        return isCancelled();
      },
      onCancellationRequested(listener: () => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };

export class LanguageModelChatMessage {
  constructor(
    public readonly role: number,
    public readonly content: string
  ) {}

  static User(content: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content);
  }
}

export class LanguageModelError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }

  static NoPermissions(message = "No permission"): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }

  static Blocked(message = "Blocked"): LanguageModelError {
    return new LanguageModelError(message, "Blocked");
  }

  static NotFound(message = "Not found"): LanguageModelError {
    return new LanguageModelError(message, "NotFound");
  }
}
