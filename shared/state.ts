export const taskStatuses = [
  "permission",
  "error",
  "running",
  "initializing",
  "done",
  "idle",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export interface MenuTask {
  id: string;
  title: string;
  provider: string;
  project: string;
  status: TaskStatus;
  updatedAt: number;
  startedAt: number | null;
  url: string | null;
}

export interface MenuFrame {
  version: 1;
  connection: "waiting" | "connected" | "error";
  message: string;
  updatedAt: number;
  counts: Record<TaskStatus, number>;
  tasks: MenuTask[];
  omitted: number;
}
