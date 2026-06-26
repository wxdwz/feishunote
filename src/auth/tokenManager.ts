import * as vscode from 'vscode';

const ACCESS_TOKEN_KEY = 'feishunote_access_token';
const REFRESH_TOKEN_KEY = 'feishunote_refresh_token';
const EXPIRES_AT_KEY = 'feishunote_expires_at';

export interface TokenData {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
}

export class TokenManager {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async getToken(): Promise<TokenData | undefined> {
        const accessToken = await this.context.secrets.get(ACCESS_TOKEN_KEY);
        if (!accessToken) {
            return undefined;
        }

        const refreshToken = await this.context.secrets.get(REFRESH_TOKEN_KEY);
        const expiresAtStr = await this.context.secrets.get(EXPIRES_AT_KEY);

        return {
            accessToken,
            refreshToken: refreshToken ?? undefined,
            expiresAt: expiresAtStr ? Number(expiresAtStr) : undefined,
        };
    }

    async saveToken(data: TokenData): Promise<void> {
        await this.context.secrets.store(ACCESS_TOKEN_KEY, data.accessToken);
        if (data.refreshToken) {
            await this.context.secrets.store(REFRESH_TOKEN_KEY, data.refreshToken);
        }
        if (data.expiresAt) {
            await this.context.secrets.store(EXPIRES_AT_KEY, String(data.expiresAt));
        }
    }

    async clearToken(): Promise<void> {
        await this.context.secrets.delete(ACCESS_TOKEN_KEY);
        await this.context.secrets.delete(REFRESH_TOKEN_KEY);
        await this.context.secrets.delete(EXPIRES_AT_KEY);
    }

    isTokenExpired(token: TokenData): boolean {
        if (!token.expiresAt) {
            return false;
        }
        // 提前 5 分钟判断过期
        return Date.now() > token.expiresAt - 5 * 60 * 1000;
    }
}