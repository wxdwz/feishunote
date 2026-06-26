import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TokenManager } from './auth/tokenManager';
import { FeishuOAuth } from './auth/oauth';
import { FeishuApi, extractDocTokenFromUrl } from './api/feishuApi';
import { DocPreviewViewProvider } from './view/docPreview';

let tokenManager: TokenManager;
let docPreviewProvider: DocPreviewViewProvider;
let currentDocToken: string | null = null;
let currentDocTitle: string | null = null;
const openEditors: Map<string, string> = new Map(); // file Uri string -> docToken
let context: vscode.ExtensionContext;
let currentOAuthInstance: FeishuOAuth | null = null; // 保存当前的 OAuth 实例

export function activate(ctx: vscode.ExtensionContext) {
    console.log('飞书文档扩展已激活');

    context = ctx;
    tokenManager = new TokenManager(context);

    // 创建 DocPreviewViewProvider，绑定 action 回调
    docPreviewProvider = new DocPreviewViewProvider(context, (action) => {
        handleAction(action);
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DocPreviewViewProvider.viewType,
            docPreviewProvider
        )
    );

    // 监听文档保存事件
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            await handleDocumentSave(document);
        })
    );

    // 监听文档关闭事件
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            handleDocumentClose(document);
        })
    );
}

async function checkLoginState(): Promise<void> {
    const tokenData = await tokenManager.getToken();
    if (tokenData && !tokenManager.isTokenExpired(tokenData)) {
        docPreviewProvider.setLoggedIn(true);
        await loadDocumentList();
    } else {
        docPreviewProvider.setLoggedIn(false);
    }
}

function handleAction(action: { type: string; url?: string; docToken?: string; title?: string; docType?: string }): void {
    switch (action.type) {
        case 'login':
            login().then();
            break;
        case 'openDoc':
            if (action.url) {
                openDocWithUrl(action.url).then();
            }
            break;
        case 'openDocByToken':
            if (action.docToken) {
                loadDocument(action.docToken).then();
            }
            break;
        case 'showCreateDialog':
            showCreateDocumentDialog().then();
            break;
        case 'createDoc':
            if (action.title) {
                createDocument(action.title).then();
            }
            break;
        case 'deleteDoc':
            if (action.docToken) {
                deleteDocument(action.docToken, action.docType).then();
            }
            break;
        case 'refreshList':
            loadDocumentList().then();
            break;
        case 'refresh':
            refreshDocument().then();
            break;
        case 'openInEditor':
            openDocumentInEditor().then();
            break;
        case 'logout':
            logout().then();
            break;
        case 'goHome':
            goHome();
            break;
        case 'syncState':
            checkLoginState().then();
            break;
    }
}

async function login(): Promise<void> {
    const config = vscode.workspace.getConfiguration('feishunote');
    const appId = config.get<string>('appId', '');
    const appSecret = config.get<string>('appSecret', '');

    if (!appId || !appSecret) {
        docPreviewProvider.showError('请在 VSCode 设置中配置 feishunote.appId 和 feishunote.appSecret');
        return;
    }

    try {
        docPreviewProvider.setLoading(true);

        // 如果有旧的 OAuth 实例，先清理
        if (currentOAuthInstance) {
            console.log('[Extension] 清理旧的 OAuth 实例');
            currentOAuthInstance.cleanup();
        }

        const oauth = new FeishuOAuth(appId, appSecret);
        currentOAuthInstance = oauth; // 保存实例

        const tokenData = await oauth.login();
        await tokenManager.saveToken(tokenData);
        docPreviewProvider.setLoggedIn(true);
        vscode.window.showInformationMessage('登录成功！');
        await loadDocumentList();
    } catch (error) {
        docPreviewProvider.setLoggedIn(false);
        docPreviewProvider.showError(`登录失败: ${(error as Error).message}`);
    }
}

async function loadDocumentList(): Promise<void> {
    const tokenData = await tokenManager.getToken();
    if (!tokenData || tokenManager.isTokenExpired(tokenData)) {
        docPreviewProvider.showError('请先登录');
        docPreviewProvider.setLoggedIn(false);
        return;
    }

    try {
        docPreviewProvider.setLoading(true);
        const api = new FeishuApi(tokenData.accessToken);
        const documents = await api.getRecentDocuments();
        docPreviewProvider.setDocumentList(documents);
    } catch (error) {
        // API 不可用时，设置空列表，回退到手动输入模式
        console.log('获取文档列表失败，回退到手动输入模式:', (error as Error).message);
        docPreviewProvider.setDocumentList([]);
    }
}

async function showCreateDocumentDialog(): Promise<void> {
    const title = await vscode.window.showInputBox({
        prompt: '请输入文档标题',
        placeHolder: '文档标题',
        validateInput: (value) => {
            if (!value || !value.trim()) {
                return '文档标题不能为空';
            }
            return null;
        }
    });

    if (title && title.trim()) {
        await createDocument(title.trim());
    }
}

async function createDocument(title: string): Promise<void> {
    const tokenData = await tokenManager.getToken();
    if (!tokenData || tokenManager.isTokenExpired(tokenData)) {
        docPreviewProvider.showError('请先登录');
        docPreviewProvider.setLoggedIn(false);
        return;
    }

    try {
        docPreviewProvider.setLoading(true);
        const api = new FeishuApi(tokenData.accessToken);
        const result = await api.createDocument(title);
        vscode.window.showInformationMessage(`文档 "${title}" 创建成功！`);
        // 刷新文档列表
        await loadDocumentList();
        // 自动打开新创建的文档
        await loadDocument(result.documentId);
    } catch (error) {
        docPreviewProvider.setLoading(false);
        docPreviewProvider.showError(`创建文档失败: ${(error as Error).message}`);
    }
}

async function deleteDocument(docToken: string, docType?: string): Promise<void> {
    const tokenData = await tokenManager.getToken();
    if (!tokenData || tokenManager.isTokenExpired(tokenData)) {
        docPreviewProvider.showError('请先登录');
        docPreviewProvider.setLoggedIn(false);
        return;
    }

    // 确认删除
    const confirm = await vscode.window.showWarningMessage(
        '确定要删除这个文档吗？',
        { modal: true },
        '删除'
    );

    if (confirm !== '删除') {
        return;
    }

    try {
        docPreviewProvider.setLoading(true);
        const api = new FeishuApi(tokenData.accessToken);
        await api.deleteDocument(docToken, docType || 'docx');
        vscode.window.showInformationMessage('文档已删除');
        // 刷新文档列表
        await loadDocumentList();
    } catch (error) {
        docPreviewProvider.setLoading(false);
        docPreviewProvider.showError(`删除文档失败: ${(error as Error).message}`);
    }
}

async function openDocWithUrl(url: string): Promise<void> {
    const tokenData = await tokenManager.getToken();
    if (!tokenData || tokenManager.isTokenExpired(tokenData)) {
        docPreviewProvider.showError('请先登录');
        docPreviewProvider.setLoggedIn(false);
        return;
    }

    const docToken = extractDocTokenFromUrl(url);
    if (!docToken) {
        docPreviewProvider.showError('无效的飞书文档链接，请检查后重试');
        return;
    }

    await loadDocument(docToken);
}

async function refreshDocument(): Promise<void> {
    if (!currentDocToken) {
        return;
    }

    const tokenData = await tokenManager.getToken();
    if (!tokenData || tokenManager.isTokenExpired(tokenData)) {
        docPreviewProvider.showError('请先登录');
        docPreviewProvider.setLoggedIn(false);
        return;
    }

    await loadDocument(currentDocToken);
}

async function loadDocument(docToken: string): Promise<void> {
    const tokenData = await tokenManager.getToken();
    if (!tokenData) {
        docPreviewProvider.showError('请先登录');
        docPreviewProvider.setLoggedIn(false);
        return;
    }

    if (tokenManager.isTokenExpired(tokenData)) {
        docPreviewProvider.showError('Token 已过期，请重新登录');
        docPreviewProvider.setLoggedIn(false);
        return;
    }

    docPreviewProvider.setLoading(true);

    try {
        const api = new FeishuApi(tokenData.accessToken);
        const content = await api.getDocumentContent(docToken);
        const docInfo = await api.getDocumentInfo(docToken);

        currentDocToken = docToken;
        currentDocTitle = docInfo.document?.title || '飞书文档';

        docPreviewProvider.updateContent(content, currentDocTitle || undefined);
    } catch (error) {
        docPreviewProvider.showError(`加载文档失败: ${(error as Error).message}`);
    }
}

async function openDocumentInEditor(): Promise<void> {
    if (!currentDocToken) {
        vscode.window.showErrorMessage('当前没有打开的文档');
        return;
    }

    const tokenData = await tokenManager.getToken();
    if (!tokenData || tokenManager.isTokenExpired(tokenData)) {
        vscode.window.showErrorMessage('登录已过期，请重新登录');
        return;
    }

    try {
        const api = new FeishuApi(tokenData.accessToken);
        const content = await api.getDocumentContent(currentDocToken);

        // 创建临时文件
        const tempDir = path.join(context.globalStorageUri.fsPath, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const fileName = `${currentDocTitle || currentDocToken}.md`;
        const filePath = path.join(tempDir, fileName);
        const fileUri = vscode.Uri.file(filePath);

        // 写入内容
        fs.writeFileSync(filePath, content, 'utf-8');

        // 记录这个文档对应的 token
        openEditors.set(fileUri.toString(), currentDocToken);

        // 在编辑器中打开
        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document);

        vscode.window.showInformationMessage(`已在编辑器中打开 "${currentDocTitle}"，保存时将自动同步到飞书`);
    } catch (error) {
        vscode.window.showErrorMessage(`打开编辑器失败: ${(error as Error).message}`);
    }
}

async function handleDocumentSave(document: vscode.TextDocument): Promise<void> {
    const docToken = openEditors.get(document.uri.toString());
    if (!docToken) {
        return; // 不是飞书文档，忽略
    }

    const tokenData = await tokenManager.getToken();
    if (!tokenData || tokenManager.isTokenExpired(tokenData)) {
        vscode.window.showWarningMessage('登录已过期，无法同步到飞书，请重新登录');
        return;
    }

    try {
        const content = document.getText();
        const api = new FeishuApi(tokenData.accessToken);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在同步到飞书...',
            cancellable: false
        }, async (_progress) => {
            await api.replaceDocumentContent(docToken, content);
            vscode.window.showInformationMessage('文档已同步到飞书');

            // 自动刷新预览区域
            if (currentDocToken === docToken) {
                await loadDocument(docToken);
            }
        });
    } catch (error) {
        vscode.window.showErrorMessage(`同步到飞书失败: ${(error as Error).message}`);
    }
}

function handleDocumentClose(document: vscode.TextDocument): void {
    const uriString = document.uri.toString();
    if (openEditors.has(uriString)) {
        openEditors.delete(uriString);

        // 可选：删除临时文件
        try {
            if (fs.existsSync(document.uri.fsPath)) {
                fs.unlinkSync(document.uri.fsPath);
            }
        } catch (error) {
            console.error('删除临时文件失败:', error);
        }
    }
}

async function logout(): Promise<void> {
    await tokenManager.clearToken();
    currentDocToken = null;
    currentDocTitle = null;
    openEditors.clear();
    docPreviewProvider.clear();
    docPreviewProvider.setLoggedIn(false);
}

function goHome(): void {
    currentDocToken = null;
    currentDocTitle = null;
    docPreviewProvider.clear();
    docPreviewProvider.setLoggedIn(true);
    loadDocumentList().then();
}

export function deactivate(): void {
    console.log('[Extension] 正在停用扩展...');

    // 清理 OAuth 服务器
    if (currentOAuthInstance) {
        console.log('[Extension] 清理 OAuth 服务器');
        currentOAuthInstance.cleanup();
        currentOAuthInstance = null;
    }

    // 清理临时文件
    openEditors.forEach((docToken, uriString) => {
        const uri = vscode.Uri.parse(uriString);
        try {
            if (fs.existsSync(uri.fsPath)) {
                fs.unlinkSync(uri.fsPath);
                console.log('[Extension] 已删除临时文件:', uri.fsPath);
            }
        } catch (error) {
            console.error('[Extension] 删除临时文件失败:', error);
        }
    });

    openEditors.clear();
    console.log('[Extension] 扩展已停用');
}