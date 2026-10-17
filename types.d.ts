/* Editor-only typings for the XR kernel and the domain model (no build step uses this file). */
declare namespace XReels {
  interface Author { id: string; username: string; name: string; avatar: string }
  interface MediaSource { url: string; type: string; bitrate?: number }
  interface Media {
    id: string; postId: string; index: number; kind: "photo" | "video" | "gif";
    thumb: string; poster: string; sources: MediaSource[]; hls?: string;
    width: number; height: number; aspect: number; duration: number; alt?: string; posterOnly?: boolean;
  }
  interface Post {
    id: string; url: string; text: string; rawText: string; lang: string;
    createdAt: number; savedAt: number; order: number; author: Author;
    metrics: { likes: number; views: number; reposts: number; replies: number };
    media: Media[]; hashtags: string[]; links: string[]; quoted?: unknown;
    flags: { sensitive?: boolean; [k: string]: unknown }; source: string; haystack: string;
  }
  type Kind = "text" | "gif" | "short" | "long" | "carousel" | "photo";
  interface QuerySpec { q?: string; kind?: string; state?: string; creator?: string; collection?: string; month?: string; savedMonth?: string; sort?: string; seed?: number; limit?: number }
  interface Route { name: string; params: Record<string, string>; query: Record<string, string>; hash: string }
  interface FeatureManifest {
    id: string; title: string; icon: string; route: string; nav?: boolean; order?: number; key?: string;
    mount(outlet: HTMLElement, route: Route): void; unmount?(): void; update?(route: Route): void;
    commands?(): Array<{ id: string; title: string; icon?: string; hint?: string; keys?: string; run(): void }>;
    shortcuts?(): void; init?(): void; pageTitle?(route: Route): string;
  }
  interface Kernel {
    define(name: string, deps: string[], factory: (...deps: any[]) => any): void;
    bind(port: string, impl: string): void;
    resolve<T = any>(name: string): T;
    resolveAll(prefix: string): any[];
    has(name: string): boolean;
    names(prefix?: string): string[];
    _reset(): void;
  }
}
declare const XR: XReels.Kernel;
interface Window { XR: XReels.Kernel; XREELS_DATA?: unknown; XREELS_TEST?: { memoryStorage?: boolean }; XREELS_MANIFEST?: { version: string; styles: string[]; vendor: string[]; scripts: string[] } }
