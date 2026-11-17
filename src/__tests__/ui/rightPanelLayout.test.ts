import { shouldDockRightPanel, DOCK_RIGHT_PANEL_MIN_AREA_WIDTH, rightPanelClassName } from '../../ui/lib/chat/rightPanelLayout';

describe('shouldDockRightPanel', () => {
  test('docks when the chat area leaves room for the messages beside the panel', () => {
    expect(shouldDockRightPanel(DOCK_RIGHT_PANEL_MIN_AREA_WIDTH)).toBe(true);
    expect(shouldDockRightPanel(1400)).toBe(true);
  });

  test('overlays when the chat area is too narrow', () => {
    expect(shouldDockRightPanel(DOCK_RIGHT_PANEL_MIN_AREA_WIDTH - 1)).toBe(false);
    expect(shouldDockRightPanel(360)).toBe(false);
  });

  test('overlays until the area has been measured', () => {
    expect(shouldDockRightPanel(0)).toBe(false);
    expect(shouldDockRightPanel(Number.NaN)).toBe(false);
  });
});

describe('rightPanelClassName', () => {
  test('a docked panel takes its own column instead of covering the messages', () => {
    const docked = rightPanelClassName(true);
    expect(docked).toContain('flex-shrink-0');
    expect(docked).not.toContain('absolute');
  });

  test('an overlaid panel floats over the right edge', () => {
    const overlay = rightPanelClassName(false);
    expect(overlay).toContain('absolute');
    expect(overlay).toContain('right-0');
    expect(overlay).toContain('max-w-[92vw]');
  });
});
