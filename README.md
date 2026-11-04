# dsh-physics-fig

让 Agent 为物理题目绘制**物理正确**的插图（受力分析）。DSH 插件（cordis bundle），向模型暴露 3 个工具，产物为 SVG 文件 + 内联 SVG 代码。

## 设计原则

**LLM 是编译器前端（自然语言 → 结构化场景），插件是确定性后端（场景 → 图）。**

- 模型只提交 PhysicsScene：拓扑（哪个块在哪面上）+ 已知量（θ、m、μ）。schema 中**不存在**方向、角度、箭头长度、坐标字段——模型没有产出几何的出口。
- 力的方向/大小全部由约束规则表 + 平衡方程解析推导：重力竖直向下；法向力沿面法线（θ 决定与竖直夹角）；静摩擦 = m·g·sinθ（平衡）且必须满足 f ≤ μN；动摩擦 = μk·N 反向。
- 渲染前逐条断言：结构合法（schemaPath 精确报错）、静力闭合（ΣF=0）、摩擦自洽、箭头长度与力大小单调、箭头起点在物体质心。**任一失败 → 拒绝写文件，返回结构化错误**。没有图好过错图。
- 闭环：错误带 `schemaPath` + `hint`，模型最小 patch 修复场景后重试。

## 工具

| 工具 | 作用 |
|---|---|
| `physics_fig_schema` | 返回 PhysicsScene JSON Schema、受控词表、填充示例。生成场景前先调用。 |
| `physics_fig_check` | 校验场景（结构 + 物理），不渲染。渲染前自查省一轮往返。 |
| `physics_fig_render` | 求解 → 校验 → 布局 → 渲染 → 写 `.svg` 文件 + 返回内联 SVG 代码。失败时返回结构化错误，不写文件。 |

## 场景示例（30° 斜面，m=2kg，μs=0.7，静止）

```json
{
  "schema_version": "1.0",
  "frame": { "units": "SI", "gravity": "down", "coord": "x-along-incline" },
  "bodies": [
    { "id": "block1", "kind": "block", "mass_kg": 2.0,
      "position": { "on": "incline1", "state": "static" } }
  ],
  "surfaces": [
    { "id": "incline1", "kind": "incline", "angle_deg": 30,
      "friction": { "mu_static": 0.7 } }
  ],
  "constraints": [ { "type": "contact", "body": "block1", "surface": "incline1" } ],
  "forces": [
    { "type": "gravity", "on": "block1" },
    { "type": "normal", "on": "block1", "from": "incline1" },
    { "type": "friction", "on": "block1", "from": "incline1" }
  ],
  "given_quantities": [ { "name": "theta", "value": 30, "unit": "deg" } ],
  "question_type": "free_body"
}
```

渲染结果：`golden-incline30.svg`（重力 19.6N 竖直向下、法向 16.97N 垂直斜面、摩擦 9.8N 沿斜面向上；角度弧线标注 30°）。

## 安装（本地开发）

```powershell
# 1) 把本目录链接/复制到 profile 的 node_modules 可解析位置
Copy-Item -Recurse dsh-physics-fig "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-physics-fig"

# 2) 在 ~/.dsh/profiles/desktop/package.json 中：
#    dependencies 添加 "dsh-physics-fig": "0.1.0"
#    dsh.profile.bundles 数组添加 "dsh-physics-fig"

# 3) 重启 DSH 桌面端
```

运行时宿主提供 `@deepseek-ai/dsh-tools` / `cordis` 等 peer 依赖（与 dsh-office-tools 相同模式）。

## 测试

```powershell
cd dsh-physics-fig
node --conditions=dsh-stub --input-type=module -e "await import('./tests/pipeline.test.js'); await import('./tests/geometry.test.js'); await import('./tests/entry.test.js')"
```

- `tests/pipeline.test.js`：求解器数值/方向断言、结构校验错误路径（12 项）
- `tests/geometry.test.js`：渲染几何回归——法向力⊥斜面、摩擦∥斜面、箭头质心起点、SVG 标注
- `tests/entry.test.js`：入口冒烟——3 工具注册、render 成功写文件、invalid 拒写、overwrite 保护
- `tests/visualize.py`：把 SVG 用 Pillow 栅格化做像素级检查（测试辅助，非插件本体）

## v0.1 范围与扩展路线

支持：单刚体 free-body（水平面 / 斜面，静/滑动，含 applied/tension 已知力）。

扩展按约束复杂度递进，每类 = 新增约束规则 + 新图元：绳+滑轮 → 杠杆/力矩 → 电路 → 光路。schema 有版本号，词表逐类放开。
