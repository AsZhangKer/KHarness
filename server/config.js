// KHarness 全局配置：桌面端 harness 无鉴权，只需端口
const path = require('path');
// .env 位于项目根目录（kharness-main/.env），从任意目录启动均可读取
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const isProduction = process.env.NODE_ENV === 'production';
const PORT = parseInt(process.env.PORT, 10) || 8317;

module.exports = { isProduction, PORT };
