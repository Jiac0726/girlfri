# server/ 目录来源与体检说明

## 一、来源（可复现）

| 项 | 值 |
|---|---|
| **上游仓库** | [`WeixinCloud/wxcloudrun-springboot`](https://github.com/WeixinCloud/wxcloudrun-springboot) |
| **说明** | 微信云托管 Spring Boot 官方模板 |
| **上游提交** | `243cbea92339efb02822c3ab7d63a549b2dca6ae`（2025-10-30 16:12:25 +0800 · `Add alert section to index.html`） |
| **上游 License** | **MIT** · Copyright (c) 2021 Tencent（`server/LICENSE` 原文保留） |
| **拉取方式** | `git clone --depth 1`，未改动任何业务代码 |
| **本仓库改动** | 仅删除 `springboot-cloudbaserun.iml`（JetBrains IDE 私有文件，与构建无关） |

> MIT 允许复制、修改、合并、发布、分发、再授权及贩售，前提是保留版权声明与许可声明。
> 本目录已保留 `LICENSE` 原文，符合要求。

---

## 二、这是什么

一个**无状态**的 Spring Boot 容器服务，跑在微信云托管（Cloud Run）上：

- **API**：`GET /api/count`（读计数）、`POST /api/count`（`{action: "inc"|"dec"}` 增减计数）
- **ORM**：MyBatis（`CountersMapper` + `mapper/CountersMapper.xml`）
- **数据表**：`Counters`（见 `src/main/resources/db.sql`）
- **部署**：`Dockerfile` + `container.config.json`

---

## 三、⚠️ 数据存储（关键架构约束）

**云托管容器的磁盘是临时的。** 代码写进容器本地的任何文件，在**重新部署 / 重启 / 扩缩容**时都会丢失。

因此：
- ❌ **不能**在容器内文件系统存业务数据
- ✅ 数据必须落在**云数据库**（模板用的是腾讯云 MySQL，经 `spring.datasource` 配置）
- ✅ 模板本身已是这个设计：容器无状态，数据在 MySQL

### 与热念现有数据的关系

热念现有数据（`couples` / `couple_users` / `ratings`）在**云开发数据库**里。引入 MySQL 后会出现**两套存储**，需要明确归属：

| 方案 | 说明 | 状态 |
|---|---|---|
| **A1** 容器用 MySQL，与云开发库各管各的 | 边界清晰，跨库一致性自管 | ⏳ 待定 |
| **A2** 容器也读写云开发数据库 | 数据只有一份，但容器需云开发凭证、失去 MyBatis 生态 | ❌ 不推荐 |
| **A3** 云开发库数据迁到 MySQL，只留 MySQL | 单一数据源，最干净 | ⏳ 待定 |

**未决定前不要在容器里写业务数据。**

---

## 四、安全体检

### ✅ 做得对的

| 项 | 现状 |
|---|---|
| **数据库凭证** | `application.yml` 用 `${MYSQL_ADDRESS}` / `${MYSQL_USERNAME}` / `${MYSQL_PASSWORD}` 环境变量取值，**零硬编码密码** |
| **License** | MIT，版权声明完整保留 |
| **依赖锁定** | `pom.xml` 显式声明版本 |

### ⚠️ 风险项

| 项 | 现状 | 建议 |
|---|---|---|
| **Spring Boot 2.5.5** | **2022 年已 EOL，不再收安全补丁**，存在已知 CVE | 上生产前**必须**升到受支持版本（3.x） |
| **`mysql-connector-java`** | 已更名为 `com.mysql:mysql-connector-j`，旧坐标不再维护 | 换新坐标 |
| **`container.config.json`** | 文件内自述「复制模板代码自行开发请忽略本配置文件」，且含 `executeSQLs` 自动建库建表 | **建议删除或忽略**，避免误以为它在生效 |
| **无鉴权** | `CounterController` 两个端点**都没有鉴权**，任何拿到服务地址的人都能改计数 | 接业务前必须加调用方校验 |
| **无输入校验** | `CounterRequest.action` 未校验取值范围 | 加白名单 |
| **`server/src/main/resources/static/index.html`** | 12KB 演示页 | 按需删除 |

### 已排除

- 未 vendor `springboot-cloudbaserun.iml`（IDE 私有文件）
- `raw.githubusercontent.com` 在本环境不可达（重定向到不可达地址），改用 `git clone` 获取，**未使用任何来路不明的镜像源**

---

## 五、下一步

1. 决定数据存储方案（A1 / A3）
2. 定义热念真实业务接口（目前只有模板的计数器）
3. 升级 Spring Boot 到受支持版本
4. 加鉴权与输入校验
5. 删除 `container.config.json`（模板部署专用）

> 本文件由助理方于 2026-09-28 记录，署名见 `docs/变更台账.md` 变更 #23。
