// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AnalyzeApiContracts from "./AnalyzeApiContracts";

describe("AnalyzeApiContracts", () => {
  const props = { projectPath: "src/index.ts", onProjectPathChange: vi.fn() };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders without crashing", () => {
    const { container } = render(<AnalyzeApiContracts {...props} />);
    expect(container.firstChild).not.toBeNull();
  });

  it("shows \"API Contract Analyzer\"", () => {
    render(<AnalyzeApiContracts {...props} />);
    expect(screen.getByText("API Contract Analyzer")).toBeTruthy();
  });

  it("shows \"Project path\"", () => {
    render(<AnalyzeApiContracts {...props} />);
    expect(screen.getByText("Project path")).toBeTruthy();
  });

  it("shows \"Focus file (optional)\"", () => {
    render(<AnalyzeApiContracts {...props} />);
    expect(screen.getByText("Focus file (optional)")).toBeTruthy();
  });

  it("calls onProjectPathChange when the control is changed", () => {
    const onProjectPathChange = vi.fn();
    render(<AnalyzeApiContracts {...props} onProjectPathChange={onProjectPathChange} />);
    fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), { target: { value: "a" } });
    expect(onProjectPathChange).toHaveBeenCalled();
  });
});
