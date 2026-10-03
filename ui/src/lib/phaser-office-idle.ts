import { officeStableHash, type OfficeAction } from "./pixel-office";
import type { OfficeAnimation } from "../components/pixel-office/types";

export interface IdleEmployee { id: string; department: string }
/** Small staggered groups keep the office alive while the real status stays idle. */
export function selectOfficeIdleBreaks(employees: IdleEmployee[], clock: number, slotMs: number, limit: number): Map<string, "coffee" | "stretch"> {
  const groups = new Map<string, IdleEmployee[]>();
  for (const employee of employees) groups.set(employee.department, [...(groups.get(employee.department) ?? []), employee]);
  const departments = [...groups.keys()].sort();
  const selected = new Map<string, "coffee" | "stretch">();
  if (!departments.length || slotMs <= 0) return selected;
  const bucket = Math.floor(Math.max(0, clock) / slotMs);
  const count = Math.min(limit, departments.length);
  for (let i = 0; i < count; i++) {
    const departmentIndex = (bucket + i) % departments.length;
    const group = groups.get(departments[departmentIndex])!.sort((a, b) => officeStableHash(a.id) - officeStableHash(b.id) || a.id.localeCompare(b.id));
    let turns = Math.floor(bucket / departments.length) * count;
    for (let previous = 0; previous < bucket % departments.length; previous++) if ((departmentIndex - previous + departments.length) % departments.length < count) turns++;
    const employee = group[turns % group.length];
    selected.set(employee.id, i === 0 ? "coffee" : "stretch");
  }
  return selected;
}

export function holdOfficePose(action: OfficeAction, moving: boolean, seated: boolean, requested: string, animation?: OfficeAnimation): boolean {
  if (seated) return action !== "working";
  if (["away", "applicant", "departed"].includes(action)) return !moving;
  return animation?.action !== requested;
}
