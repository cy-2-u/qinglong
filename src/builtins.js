// 内置任务库：面板里的任务通过 script_key 引用这里的成员。
// 新增脚本 = src/tasks/ 下新增模块（导出 run(ctx)）+ 在此注册一行 + push 自动部署。
// 为什么不做"面板贴脚本直接跑"：Workers 运行时禁止字符串编译（new Function/eval，
// 平台安全模型，免费付费一致），脚本必须随构建打包成原生模块。
import * as glados from './tasks/glados-checkin.js';
import * as dnshe from './tasks/dnshe-renew.js';

export const BUILTINS = {
  'glados-checkin': { name: 'GLaDOS 签到', params: ['cookie'], run: glados.run },
  'dnshe-renew': { name: 'DNSHE 域名续期', params: ['api_key', 'api_secret'], run: dnshe.run },
};
