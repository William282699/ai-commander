// ============================================================
// 待传队列的持久层：优先 IndexedDB，打不开就退回内存（并如实报“可能不完整”）。
//
// 内存里的那份队列（RecorderCore 持有）是工作副本；这里只负责“关页之后还在”。
// 所有方法都吞掉自己的异常并返回成败——持久层坏了只影响记录状态，不影响游戏。
// ============================================================

export interface QItem {
  eid: string;
  run: string;
  /** 这一条归哪个凭证上传（队列按局保存各自的凭证，换了测试者也不改记）。 */
  token: string;
  cls: "sample" | "critical";
  bytes: number;
  body: string;
  /** 入队顺序（跨页面加载也保持先来后到）。 */
  order: number;
}

export interface QueueBackend {
  readonly kind: "idb" | "memory";
  loadAll(): Promise<QItem[]>;
  put(items: QItem[]): Promise<boolean>;
  remove(eids: string[]): Promise<boolean>;
  /**
   * 关页那一刻的尾巴（同步写）：IndexedDB 的写在卸载时多半来不及完成，而 keepalive 在断网时也送不出去。
   * 这一小截（关页收尾标记等）同步落到 localStorage，下次加载时并回队列。尽力而为，有上限。
   */
  stashSync?(items: QItem[]): boolean;
}

const STASH_KEY = "aic_rec_pagehide_v1";
const STASH_MAX_CHARS = 200_000;

export class MemoryBackend implements QueueBackend {
  readonly kind = "memory" as const;
  async loadAll(): Promise<QItem[]> { return []; }
  async put(): Promise<boolean> { return true; }
  async remove(): Promise<boolean> { return true; }
}

const DB_NAME = "aic-playtest-recorder";
const STORE = "events";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}

export class IdbBackend implements QueueBackend {
  readonly kind = "idb" as const;
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<IdbBackend | null> {
    try {
      if (typeof indexedDB === "undefined") return null;
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "eid" });
      };
      const db = await Promise.race([
        req(r),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("idb open timeout")), 3000)),
      ]);
      return new IdbBackend(db);
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<QItem[]> {
    let stashed: QItem[] = [];
    try {
      const raw = localStorage.getItem(STASH_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) stashed = arr.filter((x) => x && typeof x.eid === "string" && typeof x.body === "string");
        // 先并进 IndexedDB 再删暂存：删了之后它们就只在 IndexedDB 里了
        if (stashed.length === 0 || await this.put(stashed)) localStorage.removeItem(STASH_KEY);
      }
    } catch { /* 暂存读不到就算了 */ }
    try {
      const tx = this.db.transaction(STORE, "readonly");
      const all = await req(tx.objectStore(STORE).getAll()) as QItem[];
      const seen = new Set(all.map((x) => x.eid));
      return [...all, ...stashed.filter((x) => !seen.has(x.eid))]
        .filter((x) => x && typeof x.eid === "string" && typeof x.body === "string").sort((a, b) => a.order - b.order);
    } catch { return stashed; }
  }

  stashSync(items: QItem[]): boolean {
    try {
      let prev: QItem[] = [];
      try { const raw = localStorage.getItem(STASH_KEY); if (raw) prev = JSON.parse(raw); } catch { prev = []; }
      const merged = [...(Array.isArray(prev) ? prev : []), ...items];
      let text = JSON.stringify(merged);
      // 超上限就只留最新的那一截（关页收尾标记在最后）
      while (text.length > STASH_MAX_CHARS && merged.length > 1) { merged.shift(); text = JSON.stringify(merged); }
      localStorage.setItem(STASH_KEY, text);
      return true;
    } catch { return false; }
  }

  async put(items: QItem[]): Promise<boolean> {
    if (items.length === 0) return true;
    try {
      const tx = this.db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      for (const it of items) st.put(it);
      await done(tx);
      return true;
    } catch { return false; }
  }

  async remove(eids: string[]): Promise<boolean> {
    if (eids.length === 0) return true;
    try {
      const tx = this.db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      for (const e of eids) st.delete(e);
      await done(tx);
      return true;
    } catch { return false; }
  }
}
