// KHarness 全局配置：桌面端 harness 无鉴权，只需端口与路径
const path = require('path');
// .env 位于项目根目录（my-project/.env），从任意目录启动均可读取
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const isProduction = process.env.NODE_ENV === 'production';
// 显式 PORT=0 表示「让系统分配空闲端口」，Electron 外壳就是这么用的，不能被 || 吃掉
const PORT = process.env.PORT !== undefined && process.env.PORT !== ''
  ? (Number.isFinite(parseInt(process.env.PORT, 10)) ? parseInt(process.env.PORT, 10) : 8317)
  : 8317;

/**
 * 数据目录。默认仍是仓库内的 server/，这样 `npm start` 的行为和以前完全一样；
 * Electron 外壳会把 KH_DATA_DIR 指到 %APPDATA%\KHarness，桌面数据不再躺进仓库。
 * 两个目录之间不自动搬：要带数据过去用 设置 → 关于 → 导出/导入数据库。
 */
const DATA_DIR = process.env.KH_DATA_DIR ? path.resolve(process.env.KH_DATA_DIR) : __dirname;
const DB_PATH = path.join(DATA_DIR, 'kh.db');
/** 前端产物目录：打包成桌面后会指到 asar 外的资源目录 */
const STATIC_DIR = process.env.KH_STATIC_DIR ? path.resolve(process.env.KH_STATIC_DIR) : path.join(__dirname, '../client/dist');
/**
 * 监听地址。这个服务没有任何鉴权，却握着全部模型密钥，所以默认只绑回环；
 * 确实要从局域网访问时显式设 KH_HOST=0.0.0.0（暴露面自己承担）。
 */
const HOST = process.env.KH_HOST || '127.0.0.1';

module.exports = { isProduction, PORT, HOST, DATA_DIR, DB_PATH, STATIC_DIR };
