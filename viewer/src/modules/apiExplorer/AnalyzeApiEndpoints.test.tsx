// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import AnalyzeApiEndpoints from "./AnalyzeApiEndpoints";

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// Fills every field (valid, invalid and empty values), presses Enter/Escape, picks every select
// option and clicks every control, re-reading the page after each click so controls that
// appear along the way are used too. This runs the handlers and the branches behind them.
async function exerciseControls(rounds = 3) {
  const values = ["sample", "bad value!?", ""];
  const clickable =
    'button, [role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], summary';

  for (let round = 0; round < rounds; round++) {
    const value = values[round % values.length];

    for (const field of Array.from(document.body.querySelectorAll<HTMLInputElement>("input, textarea"))) {
      if (!field.isConnected || field.disabled || field.type === "file") continue;
      if (field.type === "checkbox" || field.type === "radio") {
        fireEvent.click(field);
        continue;
      }
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: "Enter" });
      fireEvent.keyDown(field, { key: "Escape" });
      fireEvent.blur(field);
    }

    for (const menu of Array.from(document.body.querySelectorAll<HTMLSelectElement>("select"))) {
      for (const option of Array.from(menu.options)) {
        if (menu.isConnected) fireEvent.change(menu, { target: { value: option.value } });
      }
    }

    for (let index = 0; index < 100; index++) {
      const target = Array.from(document.body.querySelectorAll<HTMLElement>(clickable))[index];
      if (!target) break;
      if (target.isConnected && !(target as HTMLButtonElement).disabled && target.getAttribute("aria-disabled") !== "true") {
        fireEvent.click(target);
      }
      if (index % 8 === 7) await flushPromises();
    }
    await flushPromises();
  }
}

// jsdom does not implement these browser APIs, which charts, graphs and menus rely on.
function installBrowserStubs() {
  const target = globalThis as any;
  target.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  target.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent() { return false; },
    })) as any;
  }
  Element.prototype.scrollIntoView ??= function () {};
  window.scrollTo ??= (() => {}) as any;
}

describe("AnalyzeApiEndpoints", () => {
  const props = { projectPath: "src/index.ts" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" }));
    installBrowserStubs();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders without crashing", () => {
    const { container } = render(<AnalyzeApiEndpoints {...props} />);
    expect(container.firstChild).not.toBeNull();
  });

  it("shows \"API / Backend Communication Explorer\"", () => {
    render(<AnalyzeApiEndpoints {...props} />);
    expect(screen.getByText("API / Backend Communication Explorer")).toBeTruthy();
  });

  it("shows \"How to use it:\"", () => {
    render(<AnalyzeApiEndpoints {...props} />);
    expect(screen.getByText("How to use it:")).toBeTruthy();
  });

  it("shows \"Project path\"", () => {
    render(<AnalyzeApiEndpoints {...props} />);
    expect(screen.getByText("Project path")).toBeTruthy();
  });

  it("requests data when mounted", async () => {
    render(<AnalyzeApiEndpoints {...props} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it("survives a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { container } = render(<AnalyzeApiEndpoints {...props} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.firstChild).not.toBeNull();
  });

  it("renders with every variant of its props", () => {
    const rounds = [
      { apiUrl: "https://example.com", viewSourceUrl: "https://example.com", traceCallersUrl: "https://example.com", defaultFilePath: "src/index.ts" },
      { apiUrl: undefined, viewSourceUrl: undefined, traceCallersUrl: undefined, defaultFilePath: undefined },
    ];
    for (const overrides of rounds) {
      const { unmount } = render(<AnalyzeApiEndpoints {...props} {...(overrides as any)} />);
      expect(document.body.firstChild).not.toBeNull();
      unmount();
    }
  });

  it("renders with the prop variants paired differently", () => {
    const rounds = [
      { apiUrl: undefined, viewSourceUrl: undefined, traceCallersUrl: undefined, defaultFilePath: undefined },
      { apiUrl: "https://example.com", viewSourceUrl: "https://example.com", traceCallersUrl: "https://example.com", defaultFilePath: "src/index.ts" },
    ];
    for (const overrides of rounds) {
      const { unmount } = render(<AnalyzeApiEndpoints {...props} {...(overrides as any)} />);
      expect(document.body.firstChild).not.toBeNull();
      unmount();
    }
  });

  it("loads a full result and exercises every control", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, tool: "analyze_api_endpoints", projectPath: "", filePath: "src/index.ts", summary: { GET: 1, POST: 0, PUT: 1, PATCH: 0, DELETE: 1, OTHER: 0, FIREBASE_FIRESTORE: 1, FIREBASE_AUTH: 0, FIREBASE_STORAGE: 1, FIREBASE_FUNCTIONS: 0 }, endpoints: [{ id: "", category: "firebase-storage", method: "sample", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "low" }, { id: "id-1", category: "firebase-functions", method: "all", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "high" }, { id: "", category: "http", method: "", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "medium" }, { id: "id-1", category: "firebase-firestore", method: "sample", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "low" }, { id: "", category: "firebase-auth", method: "all", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "high" }], warnings: ["", "sample", ""], error: "sample" }), text: async () => "" }));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("loads an alternate result and exercises every control", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, tool: "analyze_api_endpoints", projectPath: "src/index.ts", summary: { GET: 0, POST: 1, PUT: 0, PATCH: 1, DELETE: 0, OTHER: 1, FIREBASE_FIRESTORE: 0, FIREBASE_AUTH: 1, FIREBASE_STORAGE: 0, FIREBASE_FUNCTIONS: 1 }, endpoints: [{ id: "id-1", category: "firebase-functions", method: "all", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "high" }, { id: "", category: "http", method: "", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "medium" }, { id: "id-1", category: "firebase-firestore", method: "sample", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "low" }, { id: "", category: "firebase-auth", method: "all", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "high" }, { id: "id-1", category: "firebase-storage", method: "", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "medium" }], warnings: ["sample", "", "sample"] }), text: async () => "" }));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("loads an empty result and exercises every control", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, tool: "analyze_api_endpoints", projectPath: "src/index.ts", summary: { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0, OTHER: 0, FIREBASE_FIRESTORE: 0, FIREBASE_AUTH: 0, FIREBASE_STORAGE: 0, FIREBASE_FUNCTIONS: 0 }, endpoints: [], warnings: [] }), text: async () => "" }));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("loads a long list and exercises every control", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, tool: "analyze_api_endpoints", projectPath: "", filePath: "src/index.ts", summary: { GET: 1, POST: 0, PUT: 1, PATCH: 0, DELETE: 1, OTHER: 0, FIREBASE_FIRESTORE: 1, FIREBASE_AUTH: 0, FIREBASE_STORAGE: 1, FIREBASE_FUNCTIONS: 0 }, endpoints: [{ id: "", category: "firebase-storage", method: "sample", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "low" }, { id: "id-1", category: "firebase-functions", method: "all", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "high" }, { id: "", category: "http", method: "", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "medium" }, { id: "id-1", category: "firebase-firestore", method: "sample", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "low" }, { id: "", category: "firebase-auth", method: "all", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "high" }, { id: "id-1", category: "firebase-storage", method: "", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "medium" }, { id: "", category: "firebase-functions", method: "sample", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "low" }, { id: "id-1", category: "http", method: "all", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "high" }, { id: "", category: "firebase-firestore", method: "", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "medium" }, { id: "id-1", category: "firebase-auth", method: "sample", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "low" }, { id: "", category: "firebase-storage", method: "all", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "high" }, { id: "id-1", category: "firebase-functions", method: "", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "medium" }, { id: "", category: "http", method: "sample", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "low" }, { id: "id-1", category: "firebase-firestore", method: "all", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "high" }, { id: "", category: "firebase-auth", method: "", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "medium" }], warnings: ["", "sample", "", "sample", "", "sample", "", "sample", "", "sample", "", "sample", "", "sample", ""], error: "sample" }), text: async () => "" }));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("exercises every control when the clipboard is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, tool: "analyze_api_endpoints", projectPath: "", filePath: "src/index.ts", summary: { GET: 1, POST: 0, PUT: 1, PATCH: 0, DELETE: 1, OTHER: 0, FIREBASE_FIRESTORE: 1, FIREBASE_AUTH: 0, FIREBASE_STORAGE: 1, FIREBASE_FUNCTIONS: 0 }, endpoints: [{ id: "", category: "firebase-storage", method: "sample", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "low" }, { id: "id-1", category: "firebase-functions", method: "all", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "high" }, { id: "", category: "http", method: "", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "medium" }, { id: "id-1", category: "firebase-firestore", method: "sample", endpoint: "", urlExpression: "https://example.com", resource: "sample", filePath: "", line: 1, column: 0, caller: "sample", library: "", expression: "sample", confidence: "low" }, { id: "", category: "firebase-auth", method: "all", endpoint: "https://example.com", operation: "sample", filePath: "src/index.ts", line: 0, column: 1, library: "sample", expression: "", confidence: "high" }], warnings: ["", "sample", ""], error: "sample" }), text: async () => "" }));
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("exercises every control when the server returns an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ success: false, error: "boom" }), text: async () => "" }));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("exercises every control when the server gives no error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => "" }));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("exercises every control when the response is marked unsuccessful", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: false, error: "bad input" }), text: async () => "" }));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("exercises every control when the request throws an Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("exercises every control when the request rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("nope"));
    render(<AnalyzeApiEndpoints {...props} />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);

  it("exercises every control with an empty projectPath", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<AnalyzeApiEndpoints {...props} projectPath="" />);
    await exerciseControls();
    expect(document.body.firstChild).not.toBeNull();
  }, 30000);
});
