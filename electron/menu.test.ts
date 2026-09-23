import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMenu } from "./menu";

const electron = vi.hoisted(() => ({
  Menu: { buildFromTemplate: vi.fn((template: unknown) => ({ template })) },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/Users/me/crew/node_modules/electron/dist/electron"),
    getVersion: vi.fn(() => "0.1.4"),
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
}));

vi.mock("electron", () => electron);

type Item = { label?: string; role?: string; type?: string; accelerator?: string; click?: () => void; submenu?: Item[] };

function template(): Item[] {
  const menu = buildMenu() as unknown as { template: Item[] };
  return menu.template;
}

function submenu(label: string): Item[] {
  const menu = template().find((item) => item.label === label);
  if (!menu?.submenu) throw new Error(`no ${label} menu`);
  return menu.submenu;
}

function roles(items: Item[]): string[] {
  return items.flatMap((item) => [...(item.role ? [item.role] : []), ...roles(item.submenu ?? [])]);
}

describe("buildMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the menu Electron built from the template", () => {
    const menu = buildMenu();
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(menu).toBe(electron.Menu.buildFromTemplate.mock.results[0]?.value);
  });

  it("offers the standard app roles, quit included", () => {
    expect(roles(submenu("Crew"))).toEqual(["about", "hide", "hideOthers", "unhide", "quit"]);
  });

  it("keeps the edit roles so clipboard shortcuts reach the renderer", () => {
    expect(roles(submenu("Edit"))).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
  });

  it("offers minimize and zoom on the window menu", () => {
    expect(roles(submenu("Window"))).toEqual(["minimize", "zoom"]);
  });

  it("has no reload, force reload or devtools role, so Cmd+R cannot reload the app", () => {
    const all = roles(template());
    for (const role of ["reload", "forceReload", "toggleDevTools", "viewMenu"]) expect(all).not.toContain(role);
    expect(template().map((item) => item.label)).toEqual(["Crew", "Edit", "Window"]);
  });

  it("binds no custom accelerators", () => {
    const items = template().flatMap((menu) => menu.submenu ?? []);
    expect(items.filter((item) => item.accelerator)).toEqual([]);
  });

  it("runs a manual update check from Check for Updates", () => {
    const item = submenu("Crew").find((entry) => entry.label?.startsWith("Check for Updates"));
    expect(item?.click).toBeTypeOf("function");
    item?.click?.();
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Updates apply to the installed app" }),
    );
  });
});
