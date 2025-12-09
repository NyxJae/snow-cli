/**
 * 测试checkpoint与有用信息的集成功能
 */

import {checkpointManager} from '../utils/session/checkpointManager.js';
import {getUsefulInfoService} from '../utils/execution/mcpToolsManager.js';
import fs from 'fs/promises';
import path from 'path';

async function runIntegrationTest() {
	console.log('🧪 开始测试checkpoint与有用信息的集成功能...\n');

	const sessionId = 'test-session-' + Date.now();
	const testFile = path.join(process.cwd(), 'test-file.txt');

	try {
		// 1. 准备测试文件
		const testContent = `1→First line
2→Second line
3→Third line
4→Fourth line
5→Fifth line`;
		await fs.writeFile(testFile, testContent, 'utf-8');
		console.log('✅ 测试文件已创建\n');

		// 2. 获取服务实例
		const usefulInfoService = getUsefulInfoService();

		// 3. 添加一些有用信息
		const addRequests = [
			{
				filePath: testFile,
				startLine: 2,
				endLine: 4,
				description: '测试文件中间部分',
			},
			{
				filePath: testFile,
				startLine: 1,
				endLine: 3,
				description: '测试文件开头部分',
			},
		];

		const addResult = await usefulInfoService.addUsefulInfo(
			sessionId,
			addRequests,
		);
		console.log('✅ 有用信息已添加:', {
			itemsCount: addResult.list.items.length,
			descriptions: addResult.list.items.map(item => item.description),
			failedCount: addResult.failed.length,
		});

		// 4. 创建checkpoint
		await checkpointManager.createCheckpoint(sessionId, 5);
		console.log('✅ Checkpoint已创建\n');

		// 5. 修改有用信息（模拟后续操作）
		const modifyRequests = [
			{
				filePath: testFile,
				startLine: 3,
				endLine: 5,
				description: '修改后的测试信息',
			},
		];

		const modifyResult = await usefulInfoService.addUsefulInfo(
			sessionId,
			modifyRequests,
		);
		console.log('✅ 有用信息已修改:', {
			itemsCount: modifyResult.list.items.length,
			descriptions: modifyResult.list.items.map(item => item.description),
			failedCount: modifyResult.failed.length,
		});
		console.log('📝 修改后的有用信息项数量:', modifyResult.list.items.length);

		// 6. 执行回退
		console.log('\n🔄 执行checkpoint回退...');
		const rollbackMessageCount = await checkpointManager.rollback(sessionId);

		if (rollbackMessageCount !== null) {
			console.log('✅ 回退成功，回退到消息数量:', rollbackMessageCount);
		} else {
			console.log('❌ 回退失败');
			return;
		}

		// 7. 验证有用信息是否正确恢复
		const restoredList = await usefulInfoService.getUsefulInfoList(sessionId);
		console.log('\n📋 验证回退结果:');
		console.log('回退后的有用信息项数量:', restoredList?.items.length || 0);

		if (restoredList && restoredList.items.length > 0) {
			console.log('恢复的有用信息:');
			restoredList.items.forEach((item, index) => {
				console.log(
					`  ${index + 1}. ${item.description} (${item.filePath}[${
						item.startLine
					}-${item.endLine}])`,
				);
			});
		}

		// 8. 清理测试数据
		await usefulInfoService.deleteUsefulInfoList(sessionId);
		await fs.unlink(testFile);
		console.log('\n🧹 测试数据已清理');

		// 9. 判断测试是否成功
		if (restoredList && restoredList.items.length >= 2) {
			console.log('\n🎉 测试通过！checkpoint与有用信息集成功能正常工作');
		} else {
			console.log('\n❌ 测试失败：有用信息未正确恢复');
		}
	} catch (error) {
		console.error('❌ 测试过程中发生错误:', error);

		// 清理测试文件
		try {
			await fs.unlink(testFile);
		} catch {}
	}
}

// 运行测试
runIntegrationTest().catch(console.error);
