/** "Tạo bởi" line of a schedule or draft the boss sees. `names` is null until the employee list has loaded (then nothing is shown, never a wrong "đã xoá"). */
export function creatorLine(createdByEmployee: string | null | undefined, names: ReadonlyMap<string, string> | null): string | null {
  if (!createdByEmployee || !names) return null;
  return `Tạo bởi: ${names.get(createdByEmployee) || 'nhân viên đã xoá'}`;
}
