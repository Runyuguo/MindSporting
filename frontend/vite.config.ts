import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// vitest/config 的 defineConfig 在 vite 配置类型上追加 test 字段
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // 编辑器/代理写文件时会在源码目录里产生临时文件（`<name>.tmpdir/<name>.tmp`），
      // 用完即删。Vite 的 watcher 会在它们被创建的瞬间去 watch，拿到 Windows 的
      // EBUSY（文件已删/被占用）后**整个 dev server 直接退出**（实测崩了两次）。
      // 忽略这类临时物即可；它们本就不是要构建的源码。
      ignored: ['**/*.tmpdir/**', '**/*.tmp'],
    },
    proxy: {
      // `/doc`（文献卡只读取文）与 /ask、/search 同属 127.0.0.1:8000 上的同源端点；
      // 不代理会被 Vite 的 SPA 回退吞成 index.html，前端解析成「服务端故障」。
      // `/capabilities`（生成参数能力，T49）同理：**新增只读端点必须同步补这里**
      // （AGENTS.md §6.1），生产反代同样要转发，否则滑杆会永久停在「待确认」。
      '/doc': 'http://127.0.0.1:8000',
      '/capabilities': 'http://127.0.0.1:8000',
      '/search': 'http://127.0.0.1:8000',
      '/ask': 'http://127.0.0.1:8000',
      '/reindex': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
