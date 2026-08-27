/** Minimal stand-in for the Obsidian API, enough to drive store + tracker. */

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export class TFile {
  extension: string;
  basename: string;
  stat = { mtime: 0, ctime: 0, size: 0 };

  constructor(
    public path: string,
    public content: string,
  ) {
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    this.basename = dot === -1 ? name : name.slice(0, dot);
    this.extension = dot === -1 ? "" : name.slice(dot + 1);
  }
}

export class TFolder {
  children: TFile[] = [];
  constructor(public path: string) {}
}

export const notices: string[] = [];

export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

export class MarkdownView {}

export class FakeVault {
  private readonly files = new Map<string, TFile>();
  private readonly folders = new Set<string>();

  add(path: string, content: string): TFile {
    const file = new TFile(path, content);
    this.files.set(path, file);

    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      this.folders.add(parts.slice(0, i).join("/"));
    }

    return file;
  }

  getFileByPath(path: string): TFile | null {
    return this.files.get(normalizePath(path)) ?? null;
  }

  getFolderByPath(path: string): TFolder | null {
    const key = normalizePath(path);
    if (!this.folders.has(key)) return null;

    const folder = new TFolder(key);
    folder.children = [...this.files.values()].filter(
      (file) => file.path.startsWith(`${key}/`) &&
        !file.path.slice(key.length + 1).includes("/"),
    );
    return folder;
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }

  async create(path: string, content: string): Promise<TFile> {
    return this.add(normalizePath(path), content);
  }

  async read(file: TFile): Promise<string> {
    return file.content;
  }

  async cachedRead(file: TFile): Promise<string> {
    return file.content;
  }

  async process(file: TFile, fn: (content: string) => string): Promise<string> {
    file.content = fn(file.content);
    return file.content;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((file) => file.extension === "md");
  }
}

export class FakeApp {
  vault = new FakeVault();
  workspace = { getLeavesOfType: (_type: string) => [] as unknown[] };
}

export type App = FakeApp;
