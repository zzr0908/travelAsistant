import { randomUUID } from "node:crypto";
import {
  emptyDates,
  nodeFields,
  type WorkspaceData,
} from "../../shared/model.js";
export function sampleData(): WorkspaceData {
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const [root, florence, museum, lunch, free, drive, drive2, prep] = ids;
  const data: WorkspaceData = {
    rootId: root,
    kind: "trip",
    nodes: {},
    preparations: {},
    progress: {},
    sample: true,
  };
  const add = (
    id: string,
    parentId: string | null,
    title: string,
    start: string,
    end = start,
    description = "",
    fixed = false,
  ) => {
    data.nodes[id] = {
      ...nodeFields.parse({
        title,
        description,
        fixed,
        dates: { ...emptyDates(), mode: "fixed", start, end },
      }),
      id,
      parentId,
      order: Object.keys(data.nodes).length,
    };
  };
  add(
    root,
    null,
    "意大利旅行",
    "2026-10-01",
    "2026-10-07",
    "城市里的文化与散步，乡间的自由时间。",
  );
  add(
    florence,
    root,
    "佛罗伦萨的一天",
    "2026-10-03",
    undefined,
    "参观、午餐，再留一段不赶时间的散步。",
  );
  add(
    museum,
    florence,
    "美术馆参观",
    "2026-10-03",
    undefined,
    "固定预约的验收示例，不代表已经订票。",
    true,
  );
  data.nodes[museum].dates.startTime = "09:00";
  data.nodes[museum].dates.endTime = "11:00";
  add(lunch, florence, "午餐与咖啡", "2026-10-03", undefined, "餐厅待选择。");
  add(
    free,
    florence,
    "自由散步",
    "2026-10-03",
    undefined,
    "把下午留给临时发现。",
  );
  data.nodes[free].kind = "free";
  add(
    drive,
    root,
    "乡间自驾",
    "2026-10-04",
    "2026-10-05",
    "沿途停留与取还车地点待补充。",
  );
  add(drive2, drive, "第二天的沿途停留", "2026-10-05");
  data.preparations[prep] = {
    id: prep,
    title: "自驾前的准备",
    note: "手动验收清单，具体旅行要求尚未核实。",
    nodeIds: [drive, drive2],
    steps: [
      { id: randomUUID(), text: "补充取还车地点与时间" },
      { id: randomUUID(), text: "记录需要核对的材料" },
    ],
  };
  return data;
}
