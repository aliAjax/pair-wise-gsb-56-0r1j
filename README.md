# 出口管制技术资料审批与许可核对平台

面向出口业务人员和合规人员的本地审批工作台。项目使用 React、Ant Design、Redux Toolkit、RTK Query、React Router、Vite 和 TypeScript 构建。

## 功能

- 提交图纸、技术说明、软件包、收件方、最终用途、技术参数、人员范围和声明。
- 按资料分类、国家地区、技术参数和人员范围匹配许可规则，解释缺失声明和升级审批原因。
- 拆解资料包并管理文件版本，逐页标记资料分类、受控技术和脱敏状态。
- 新文件版本不复用旧版分类结果；审批引用版本与现行版本不一致时阻断流程。
- 提交审批生成**审批冻结单**：固定声明、每个文件的现行版本（含 hash）与逐页核对结果，并从许可规则额度池预占本次额度。
- 保存资料包、登记文件、更换文件版本、修改引用版本或逐页核对页，都会让有效冻结单失效（旧快照与失效原因保留）并释放预占。
- 审批全程只按同一张冻结单进行；退回或申请人撤回释放预占，最后一步通过后在同一临界区内把预占转为实占，重复点击或前后脚并发提交不会多占。
- 按规则等级生成顺序审批路线，支持审批通过、逐项意见、多轮退回和重新发起。
- 许可额度按规则池管理（上限 / 已转用 / 预占 / 可用），额度池不足时拒绝生成冻结单。
- 比较资料包版本、跟踪文件版本差异、导出追溯 JSON（含冻结单台账）和审计 CSV。

本地模拟服务位于 RTK Query 的 `baseQuery` 中，所有写操作经互斥队列串行执行，数据保存到浏览器 `localStorage`。

冻结单端到端冒烟测试（驱动真实 RTK Query endpoints）：

```bash
npx esbuild scripts/freeze.e2e.ts --bundle --platform=node --format=esm \
  --outfile=scripts/freeze.e2e.mjs --alias:@=./src && node scripts/freeze.e2e.mjs
```

## 运行

```bash
npm install
npm run dev
```

开发服务地址：`http://localhost:18456`

## 构建

```bash
npm run build
npm run preview
```

## 目录

```text
src/
  app/         Redux Store、UI Slice、RTK Query API 与类型化 Hooks
  components/  应用外壳、页面头、状态标签
  features/    总览、资料包、逐页核对、审批、许可、版本差异、审计
  services/    模拟数据、许可规则、冻结单与额度池、校验与差异引擎、本地存储、写操作互斥
  types/       领域类型
scripts/
  freeze.e2e.ts 冻结单预占/释放/失效/转用与并发安全的端到端冒烟测试
```
