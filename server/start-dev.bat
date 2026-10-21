@echo off
rem 启动 dev 后端：显式覆盖环境变量，避免被已安装版 KHarness 的环境污染
rem 关键：KH_DATA_DIR 必须指向 dev 仓库，否则后端读写已安装版的数据
set KH_DATA_DIR=D:\1\kharness-NewUI-dev\server
set KH_STATIC_DIR=D:\1\kharness-NewUI-dev\client\dist
set KH_APP_PACKAGED=0
set KH_APP_VERSION=1.3.8
set KH_HOST=0.0.0.0
set NODE_ENV=development
set PORT=45999
node index.js