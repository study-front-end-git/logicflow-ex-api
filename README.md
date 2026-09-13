# logicflow-ex-api

LogicFlow 示例项目的 Express 后端。

## 开发

```bash
npm install
npm run dev
```

开发命令使用 nodemon 监听 `serve.js` 和 `src` 目录。默认服务地址为 `http://localhost:3000`。

## 已有接口

- `GET /api`：API 可用性检查
- `GET /api/health`：服务健康检查

环境变量可参考 `.env.example`，项目启动时会通过 dotenv 自动加载 `.env`。

## MySQL

复制 `.env.example` 为 `.env`，填写 MySQL 用户、密码和数据库名。项目使用 `mysql2` 连接池，业务代码可通过 `src/database.js` 导出的 `pool` 执行参数化 SQL。

- `GET /api/health/database`：检查 MySQL 连接状态

填写 `.env` 后初始化数据表：

```bash
npm run db:init
```

## 工作流接口

- `GET /api/workflows/:workflowKey`：读取工作流及完整节点、连线数据
- `PUT /api/workflows/:workflowKey`：创建或保存工作流
- `POST /api/workflows/:workflowKey/run`：执行已保存的工作流
- `POST /api/workflows/:workflowKey/http-nodes/test`：测试尚未保存或已编辑的 HTTP 节点配置
- `GET /api/workflows/:workflowKey/runs`：分页查询运行记录
- `GET /api/workflows/:workflowKey/runs/latest`：查询最近一次运行记录
- `GET /api/workflows/:workflowKey/runs/:runId`：查询单次运行详情

保存请求示例：

```json
{
  "name": "示例工作流",
  "description": "可选描述",
  "version": 1,
  "graphData": {
    "nodes": [],
    "edges": []
  }
}
```

首次创建时不要传 `version`；更新时传上一次接口返回的 `version`，服务端会用它检测并发修改。

执行工作流：

```json
POST /api/workflows/1/run

{
  "inputs": {
    "input": "你好"
  }
}
```

模型节点会调用 `.env` 中 `LLM_API_URL` 指定的 Agnes Chat Completions 接口。API Key 只能配置在后端，不能由浏览器提交。

每次调用运行接口都会自动保存 `inputs`、最终 `output`、节点执行轨迹、耗时以及成功或失败状态。运行成功响应中的 `runId` 可用于查询详情：

```text
GET /api/workflows/1/runs?page=1&pageSize=20
GET /api/workflows/1/runs/运行接口返回的runId
```
