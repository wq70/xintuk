# 源码结构与非回归约束

## 哪些文件是源码

- `src/views/`：按业务区域保存页面结构片段。
- `src/styles/legacy-cascade/`：按原始顺序保存样式片段。
- `src/legacy/main-app/`：原 `index.html` 内联主体脚本的有序源码片段。
- `src/features/`：现有独立功能脚本的有序源码片段。

根目录的 `index.html`、`main-app.js`、`style.css` 以及原有功能脚本是小型运行入口，由 `source-layout.json` 描述的源码生成。`runtime/` 保存浏览器加载的小型源码载荷。不要直接编辑这些生成文件；修改对应的 `src/` 文件后运行：

```powershell
npm run build
npm run check
```

构建不压缩、不重排业务源码。HTML 主体会由小型载荷在文档解析期间原样写入；CSS 入口按原层叠顺序导入完整规则文件；每组 JavaScript 载荷会先按原顺序重组，再作为一个经典脚本同步执行，因此不会把共享闭包或词法作用域切断。

## 为什么 JavaScript 使用 `.js.part`

旧主体代码存在跨越多个功能区域的共享闭包、全局词法变量和加载顺序依赖。直接把每段包装成独立模块会改变变量可见性和执行时机。`.js.part` 表示它是一个必须按清单顺序重组的经典脚本片段，不应该被单独加载或单独执行。

新增代码不应继续写入这些兼容片段。新增的独立能力应使用正常 `.js` 模块，并通过明确入口接入；迁移旧能力时必须先补齐对应行为测试，再消除共享作用域。

## 文件体积门槛

- HTML、CSS 源片段：40 KB。
- JavaScript 源片段：60 KB。
- 根目录入口：20 KB。
- `runtime/` 运行载荷：60 KB。

`npm run check` 会检查全部源码和运行载荷体积、HTML/JavaScript 载荷能否逐字还原、重组后的 JavaScript 能否按经典脚本语法解析，以及所有本地资源是否存在。
它还会对照 `protected-runtime-contract.json` 检查 DOM id、screen、内联交互、脚本加载顺序和 Dexie 数据结构是否发生未审查的变化。

## 受保护的运行契约

重构不得未经授权改变：

- screen、弹窗、按钮、设置项和所有现有 DOM id；
- HTML 结构顺序及内联事件；
- CSS 规则及层叠顺序；
- JavaScript 语句、函数、提示词、Fallback 和加载顺序；
- Dexie 数据库名称、表、索引、数据格式及迁移行为；
- PWA manifest、Service Worker、第三方脚本和资源地址；
- 用户当前能够完成的所有操作链路。

涉及以上契约的语义调整必须单独评审，不能夹带在文件整理中。
