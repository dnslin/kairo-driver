import { KK9Driver } from '../src/index.js';

async function main() {
  console.log('=== KK9 Driver 基础功能快速冒烟验证 ===\n');

  const driver = new KK9Driver({
    cdp: {
      url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
      pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
    },
  });

  try {
    const privateTarget = process.env['KK9_TEST_PRIVATE_ID']?.trim();
    const groupTarget = process.env['KK9_TEST_GROUP_ID']?.trim();
    const userId = process.env['KK9_TEST_USER_ID']?.trim();
    if (!privateTarget || !groupTarget || !userId) {
      throw new Error('必须设置 KK9_TEST_PRIVATE_ID、KK9_TEST_GROUP_ID 和 KK9_TEST_USER_ID');
    }
    // 1. 连接
    console.log('1. 正在连接 KK9 客户端...');
    await driver.connect();
    console.log(`   ✅ 连接成功！状态: ${driver.getStatus()}\n`);

    // 2. 会话
    console.log('2. 获取全量会话列表 (Bridge 数据层)...');
    const sessions = await driver.getSessions();
    console.log(`   ✅ 成功获取 ${sessions.length} 个会话\n`);

    const privateSession = sessions.find(session => session.id === privateTarget && session.type === 'private');
    const groupSession = sessions.find(session => session.id === groupTarget && session.type === 'group');
    if (!privateSession || !groupSession) throw new Error('授权私聊或群聊的原生会话 ID 不匹配');

    console.log(`3. 指定私聊原生历史读取 (目标: ${privateTarget})...`);
    const pMsgs = await driver.getRecentMessages(privateSession, 3);
    console.log(`   检索到 ${pMsgs.length} 条私聊消息`);
    pMsgs.forEach(message => console.log(JSON.stringify({ id: message.id, sessionId: message.sessionId, msgIdx: message.msgIdx })));
    console.log();

    console.log(`4. 指定群聊原生历史读取 (目标: ${groupTarget})...`);
    const gMsgs = await driver.getRecentMessages(groupSession, 3);
    console.log(`   检索到 ${gMsgs.length} 条群聊消息`);
    gMsgs.forEach(message => console.log(JSON.stringify({ id: message.id, sessionId: message.sessionId, msgIdx: message.msgIdx })));
    console.log();

    // 5. 组织架构查询
    console.log(`5. 组织架构员工档案查询 (UID: ${userId})...`);
    const profile = await driver.getUserProfile(userId);
    if (profile) {
      console.log(`   ✅ 查询成功: ${profile.name} (工号: ${profile.loginName}, 岗位: ${profile.position || '未设置'})\n`);
    } else {
      console.log('   ℹ️ 未检索到员工档案\n');
    }

    console.log('🎉 冒烟验证顺利通过！');
  } catch (err) {
    console.error('❌ 执行验证失败:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await driver.disconnect();
  }
}

void main();
