import * as vscode from 'vscode';
import * as http from 'http';
import axios, { AxiosError } from 'axios';
import { TokenData } from './tokenManager';

function describeAxiosError(err: unknown, prefix: string): Error {
    if (axios.isAxiosError(err)) {
        const ax = err as AxiosError<{ code?: number; msg?: string; error?: string; error_description?: string }>;
        const data = ax.response?.data;
        const detail = data?.msg || data?.error_description || data?.error || ax.message;
        const codePart = data?.code !== undefined ? ` (code=${data.code})` : '';
        const httpPart = ax.response?.status ? ` [HTTP ${ax.response.status}]` : '';
        return new Error(`${prefix}: ${detail}${codePart}${httpPart}`);
    }
    return new Error(`${prefix}: ${(err as Error).message || String(err)}`);
}

export class FeishuOAuth {
    private appId: string;
    private appSecret: string;
    private server: http.Server | null = null;
    private resolve: ((data: TokenData) => void) | null = null;
    private reject: ((reason: any) => void) | null = null;

    constructor(appId: string, appSecret: string) {
        this.appId = appId;
        this.appSecret = appSecret;
    }

    private get port(): number {
        return vscode.workspace.getConfiguration('feishunote').get<number>('oauthCallbackPort', 8080);
    }

    private get callbackHost(): string {
        return vscode.workspace.getConfiguration('feishunote').get<string>('oauthCallbackHost', '127.0.0.1');
    }

    private get apiBaseUrl(): string {
        return vscode.workspace.getConfiguration('feishunote').get<string>('apiBaseUrl', 'https://open.feishu.cn');
    }

    async login(): Promise<TokenData> {
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
            this.startServer();
            this.openAuthUrl();
        });
    }

    private startServer(): void {
        // 如果服务器已经在运行，先关闭
        if (this.server) {
            console.log('[OAuth] 服务器已存在，先关闭旧服务器');
            this.stopServer();
        }

        this.server = http.createServer(async (req, res) => {
            if (req.url?.includes('/callback')) {
                // 处理飞书开放平台「事件订阅」URL 验证（POST 请求，body 带 challenge）
                if (req.method === 'POST') {
                    let body = '';
                    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                    req.on('end', () => {
                        try {
                            const parsed = JSON.parse(body);
                            if (parsed.challenge) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ challenge: parsed.challenge }));
                            } else {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: 'missing challenge' }));
                            }
                        } catch {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid json' }));
                        }
                    });
                    return;
                }

                // 处理 OAuth 登录回调（GET 请求，query 带 code）
                try {
                    const url = new URL(req.url, `http://${this.callbackHost}:${this.port}`);
                    const code = url.searchParams.get('code');
                    if (code) {
                        const tokenData = await this.exchangeCode(code);
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end('<html><body><h1>授权成功！可以关闭此页面</h1></body></html>');
                        this.stopServer();
                        if (this.resolve) {
                            this.resolve(tokenData);
                        }
                    } else {
                        throw new Error('未获取到授权码');
                    }
                } catch (error) {
                    const msg = (error as Error).message || String(error);
                    console.error('[feishunote] OAuth 授权失败:', error);
                    const safe = msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<html><body style="font-family:sans-serif;padding:24px"><h1>授权失败</h1><p style="color:#c00">${safe}</p><p>请回到 VSCode 查看详细错误，或检查飞书后台「权限管理」是否已开通对应 scope。</p></body></html>`);
                    this.stopServer();
                    if (this.reject) {
                        this.reject(new Error(msg));
                    }
                }
            }
        });
        this.server.on('error', (err: any) => {
            console.error('[OAuth] 服务器错误:', err);
            this.stopServer();
            if (this.reject) {
                if (err.code === 'EADDRINUSE') {
                    this.reject(new Error(`端口 ${this.port} 已被占用，请在设置中更改 feishunote.oauthCallbackPort 或关闭占用该端口的程序`));
                } else {
                    this.reject(new Error(`OAuth 服务启动失败: ${err.message}`));
                }
            }
        });
        this.server.listen(this.port, () => {
            console.log(`[OAuth] 服务器已启动，监听端口 ${this.port}`);
        });
    }

    private stopServer(): void {
        if (this.server) {
            console.log('[OAuth] 正在关闭服务器...');

            // 1. 首先强制关闭所有活动连接
            if (typeof this.server.closeAllConnections === 'function') {
                this.server.closeAllConnections();
                console.log('[OAuth] 已关闭所有连接');
            }

            // 2. 然后关闭服务器
            this.server.close((err) => {
                if (err) {
                    console.error('[OAuth] 关闭服务器时出错:', err);
                } else {
                    console.log('[OAuth] 服务器已成功关闭');
                }
            });

            // 3. 立即取消引用，防止重复使用
            const oldServer = this.server;
            this.server = null;

            // 4. 强制 unref，让 Node.js 不再等待这个服务器
            oldServer.unref();
        }
    }

    /**
     * 公共方法：停止 OAuth 服务器（供外部清理使用）
     */
    public cleanup(): void {
        this.stopServer();
    }

    private openAuthUrl(): void {
        const redirectUri = encodeURIComponent(`http://${this.callbackHost}:${this.port}/callback`);
        // 请求完整的文档操作权限
        const scope = [
            'docx:document:readonly',  // 查看文档
            'docx:document',           // 创建和编辑文档
            'drive:drive',             // 云空间操作（删除等）
        ].join(' ');
        const authUrl = `${this.apiBaseUrl}/open-apis/authen/v1/authorize?app_id=${this.appId}&redirect_uri=${redirectUri}&scope=${scope}&state=vscode`;
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
    }

    private async getAppAccessToken(): Promise<string> {
        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/open-apis/auth/v3/app_access_token/internal`,
                {
                    app_id: this.appId,
                    app_secret: this.appSecret
                }
            );
            if (response.data.code !== 0) {
                throw new Error(`${response.data.msg || 'unknown'} (code=${response.data.code})`);
            }
            return response.data.app_access_token;
        } catch (err) {
            throw describeAxiosError(err, '获取 app_access_token 失败');
        }
    }

    private async exchangeCode(code: string): Promise<TokenData> {
        const appAccessToken = await this.getAppAccessToken();
        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/open-apis/authen/v1/oidc/access_token`,
                {
                    grant_type: 'authorization_code',
                    code
                },
                {
                    headers: {
                        'Authorization': `Bearer ${appAccessToken}`,
                        'Content-Type': 'application/json; charset=utf-8'
                    }
                }
            );

            if (response.data.code !== 0) {
                throw new Error(`${response.data.msg || 'unknown'} (code=${response.data.code})`);
            }

            const data = response.data.data;
            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: Date.now() + (data.expires_in * 1000)
            };
        } catch (err) {
            throw describeAxiosError(err, '换取 user_access_token 失败');
        }
    }
}
