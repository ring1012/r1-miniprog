// Java String.hashCode 对齐：h = (31*h + c) | 0，abs 后对 6 取模。
export function hashMod6(deviceId: string): number {
  let h = 0;
  for (let i = 0; i < deviceId.length; i++) {
    h = Math.imul(31, h) + deviceId.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) % 6;
}

export function hostFor(deviceId: string): string {
  return `xn--3ug.t${hashMod6(deviceId)}.typo.de5.net`;
}

// 单测向量："0".charCodeAt(0)=48 → h=48 → 48%6=0 → t0
