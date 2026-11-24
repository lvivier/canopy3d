export function isTouchUi(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(hover: none) and (pointer: coarse)').matches ||
    window.matchMedia('(max-width: 520px)').matches
  );
}

export function cameraOrbitZoomHint(): string {
  return isTouchUi()
    ? 'Two-finger drag to Orbit · Pinch to Zoom'
    : 'Drag or Right-Click to Orbit · Scroll or pinch to Zoom';
}

export function introSkipHint(): string {
  return isTouchUi()
    ? 'Tap, pinch, or two-finger drag to skip intro'
    : 'Click, scroll, or right-drag to skip intro';
}

export function orbitOnlyHint(): string {
  return isTouchUi() ? 'Two-finger drag to Orbit' : 'Drag or Right-Click to Orbit';
}

/** Rewrite pointer-specific phrases for touch UI (HUD, toasts, dynamic copy). */
export function localizeControlCopy(text: string): string {
  if (!isTouchUi()) return text;
  return text
    .replace(/\bRight-Click Drag\b/g, 'Two-finger drag')
    .replace(/\bright-drag\b/gi, 'two-finger drag')
    .replace(/\bDrag with Right-Click\b/gi, 'Two-finger drag')
    .replace(/\bHold Left-Click\b/g, 'Touch & hold')
    .replace(/\bhold Left-Click\b/g, 'touch & hold')
    .replace(/\bLeft-Click\b/g, 'Tap')
    .replace(/\bClick another\b/g, 'Tap another')
    .replace(/\bclick the trunk\b/gi, 'tap the trunk')
    .replace(/\bclick Re-Aim\b/gi, 'tap Re-Aim')
    .replace(/\bHover\b/g, 'Touch')
    .replace(/\bhover\b/g, 'touch')
    .replace(/\bMove cursor\b/g, 'Drag aim')
    .replace(/Scroll or pinch/gi, 'Pinch')
    .replace(/\bscroll to zoom\b/gi, 'pinch to zoom');
}