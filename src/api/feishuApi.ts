import axios from 'axios';
import * as vscode from 'vscode';
import { extractDocTokenFromUrl } from '../utils';

export interface DocumentContent {
    content: string;
}

export class FeishuApi {
    private accessToken: string;
    private apiBaseUrl: string;

    constructor(accessToken: string) {
        this.accessToken = accessToken;
        this.apiBaseUrl = vscode.workspace.getConfiguration('feishunote')
            .get<string>('apiBaseUrl', 'https://open.feishu.cn')!;
    }

    private getLangParam(): number {
        const lang = vscode.workspace.getConfiguration('feishunote')
            .get<string>('documentLanguage', 'zh');
        switch (lang) {
            case 'en': return 1;
            case 'ja': return 2;
            default: return 0;
        }
    }

    /**
     * 获取文档纯文本内容（新版 docx API）
     * 飞书新版文档 API: GET /open-apis/docx/v1/documents/:document_id/raw_content
     */
    async getDocumentRawContent(documentId: string): Promise<string> {
        const response = await axios.get(
            `${this.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/raw_content`,
            {
                params: { lang: this.getLangParam() },
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        if (response.data.code !== 0) {
            throw new Error(response.data.msg || '获取文档纯文本内容失败');
        }

        return response.data.data.content;
    }

    /**
     * 获取文档内容并转换为 Markdown 格式。
     *
     * 飞书未提供官方的 docx → Markdown 导出接口，所以这里走「拉取所有 Block → 自行转换」的路径。
     * 旧实现误用了已废弃的 /open-apis/docs/v1/content（仅适用于 v2 doc，docx 文档会丢格式或报错），
     * fallback 又是纯文本接口 raw_content，因此 Markdown 格式被丢失。
     */
    async getDocumentContent(docToken: string): Promise<string> {
        console.log('[getDocumentContent] 通过 blocks API 转换为 Markdown:', docToken);
        try {
            const markdown = await this.convertBlocksToMarkdown(docToken);
            console.log('[getDocumentContent] 转换得到 markdown 长度:', markdown.length);
            return markdown;
        } catch (err) {
            console.log('[getDocumentContent] blocks 转换失败，回退到纯文本:', (err as Error).message);
            return await this.getDocumentRawContent(docToken);
        }
    }

    async getDocumentInfo(documentId: string) {
        const response = await axios.get(
            `${this.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}`,
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        if (response.data.code !== 0) {
            throw new Error(response.data.msg || '获取文档信息失败');
        }

        return response.data.data;
    }

    async getRootFolderToken(): Promise<string | null> {
        try {
            console.log('[getRootFolderToken] 方法 1: 尝试 root_folder/meta API');
            const metaResponse = await axios.get(
                `${this.apiBaseUrl}/open-apis/drive/explorer/v2/root_folder/meta`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    }
                }
            );

            console.log('[getRootFolderToken] meta 响应:', JSON.stringify(metaResponse.data, null, 2));

            if (metaResponse.data.code === 0 && metaResponse.data.data?.token) {
                const token = metaResponse.data.data.token;
                console.log('[getRootFolderToken] meta 返回 token:', token);
                return token;
            }

            // 如果第一个方法失败，尝试第二个方法：列出根目录，找"我的文档库"
            console.log('[getRootFolderToken] 方法 2: 列出云空间根目录，查找个人文件夹');
            const filesResponse = await axios.get(
                `${this.apiBaseUrl}/open-apis/drive/v1/files`,
                {
                    params: {
                        page_size: 50
                        // folder_token 为空时获取云空间根目录
                    },
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    }
                }
            );

            console.log('[getRootFolderToken] files 响应:', JSON.stringify(filesResponse.data, null, 2));

            if (filesResponse.data.code === 0 && filesResponse.data.data?.files) {
                const folders = filesResponse.data.data.files.filter((f: any) => f.type === 'folder');
                console.log('[getRootFolderToken] 找到文件夹:', folders.map((f: any) => f.name));

                // 查找"我的文档库"或类似名称的文件夹
                const myFolder = folders.find((f: any) =>
                    f.name === '我的文档库' ||
                    f.name === '我的空间' ||
                    f.name === 'My Documents'
                );

                if (myFolder) {
                    console.log('[getRootFolderToken] 找到个人文件夹:', myFolder.name, 'token:', myFolder.token);
                    return myFolder.token;
                }
            }

        } catch (error: any) {
            console.error('[getRootFolderToken] 失败:', error.response?.data || error.message);
        }
        return null;
    }

    async getRecentDocuments(pageSize: number = 50): Promise<Array<{
        token: string;
        title: string;
        type: string;
        url: string;
        ownerName?: string;
        updateTime?: number;
    }>> {
        console.log('[getRecentDocuments] 开始获取文档列表...');

        // 先尝试获取根文件夹 token
        const rootToken = await this.getRootFolderToken();
        console.log('[getRecentDocuments] 根文件夹 token:', rootToken);

        const params: any = {
            page_size: pageSize,
            order_by: 'EditedTime'
        };

        // 如果有根文件夹 token，使用它
        if (rootToken) {
            params.folder_token = rootToken;
        }

        const response = await axios.get(
            `${this.apiBaseUrl}/open-apis/drive/v1/files`,
            {
                params,
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        console.log('[getRecentDocuments] API 响应:', response.data);

        if (response.data.code !== 0) {
            throw new Error(response.data.msg || '获取文档列表失败');
        }

        const items = response.data.data?.files || [];
        console.log('[getRecentDocuments] 找到', items.length, '个文件');

        // 过滤出文档类型
        const docs = items.filter((item: any) => item.type === 'docx' || item.type === 'doc');
        console.log('[getRecentDocuments] 其中文档', docs.length, '个');

        return docs.map((item: any) => ({
            token: item.token,
            title: item.name,
            type: item.type,
            url: item.url || '',
            ownerName: item.owner_id,
            updateTime: item.modified_time ? parseInt(item.modified_time) * 1000 : undefined
        }));
    }

    async createDocument(title: string, folderToken?: string): Promise<{
        documentId: string;
        revisionId: string;
        title: string;
    }> {
        // 如果没有指定 folderToken，获取根文件夹 token
        if (!folderToken) {
            folderToken = await this.getRootFolderToken() || undefined;
            console.log('[createDocument] 使用根文件夹 token:', folderToken);
        }

        const body: any = {
            title: title
        };

        // folder_token 是可选的
        if (folderToken) {
            body.folder_token = folderToken;
        }

        console.log('[createDocument] 请求 URL:', `${this.apiBaseUrl}/open-apis/docx/v1/documents`);
        console.log('[createDocument] 请求体:', JSON.stringify(body, null, 2));

        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/open-apis/docx/v1/documents`,
                body,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log('[createDocument] 响应状态:', response.status);
            console.log('[createDocument] 响应数据:', JSON.stringify(response.data, null, 2));

            if (response.data.code !== 0) {
                console.error('创建文档失败响应:', JSON.stringify(response.data));
                throw new Error(response.data.msg || '创建文档失败');
            }

            const doc = response.data.data.document;
            console.log('[createDocument] 创建成功，文档 ID:', doc.document_id);
            return {
                documentId: doc.document_id,
                revisionId: doc.revision_id || '0',
                title: doc.title || title
            };
        } catch (error: any) {
            console.error('[createDocument] 请求失败 HTTP 状态:', error.response?.status);
            console.error('[createDocument] 请求失败响应数据:', JSON.stringify(error.response?.data, null, 2));
            console.error('[createDocument] 请求失败错误:', error.message);
            throw new Error(error.response?.data?.msg || error.message || '创建文档失败');
        }
    }

    async deleteDocument(docToken: string, docType: string = 'docx'): Promise<void> {
        const response = await axios.delete(
            `${this.apiBaseUrl}/open-apis/drive/v1/files/${docToken}`,
            {
                params: {
                    type: docType
                },
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        if (response.data.code !== 0) {
            throw new Error(response.data.msg || '删除文档失败');
        }
    }

    /**
     * 获取文档的所有块（用于编辑）
     */
    async getDocumentBlocks(documentId: string): Promise<any> {
        const response = await axios.get(
            `${this.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks`,
            {
                params: {
                    page_size: 500,
                    document_revision_id: -1  // -1 表示最新版本
                },
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            }
        );

        if (response.data.code !== 0) {
            throw new Error(response.data.msg || '获取文档块失败');
        }

        return response.data.data;
    }

    /**
     * 批量更新文档块（简化版：只支持文本块的更新）
     */
    async batchUpdateBlocks(documentId: string, updates: Array<{
        blockId: string;
        text: string;
    }>): Promise<void> {
        const requests = updates.map(update => ({
            update_text: {
                elements: [{
                    text_run: {
                        content: update.text
                    }
                }]
            },
            block_id: update.blockId
        }));

        const response = await axios.patch(
            `${this.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/batch_update`,
            {
                requests
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.code !== 0) {
            throw new Error(response.data.msg || '更新文档失败');
        }
    }

    /**
     * 拉取一个文档的所有 Block（自动翻页）。
     */
    private async fetchAllBlocks(documentId: string): Promise<any[]> {
        const all: any[] = [];
        let pageToken: string | undefined;
        do {
            const params: Record<string, any> = {
                page_size: 500,
                document_revision_id: -1
            };
            if (pageToken) {
                params.page_token = pageToken;
            }
            const resp = await axios.get(
                `${this.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks`,
                {
                    params,
                    headers: { 'Authorization': `Bearer ${this.accessToken}` }
                }
            );
            if (resp.data.code !== 0) {
                throw new Error(resp.data.msg || '获取文档块失败');
            }
            const items = resp.data.data?.items || [];
            all.push(...items);
            pageToken = resp.data.data?.has_more ? resp.data.data?.page_token : undefined;
        } while (pageToken);
        return all;
    }

    /**
     * 把一组 text_element 渲染为 Markdown 行内文本（加粗 / 斜体 / 删除线 / 行内代码 / 链接）。
     */
    private renderElements(elements: any[] | undefined): string {
        if (!elements || !elements.length) { return ''; }
        let out = '';
        for (const el of elements) {
            const tr = el.text_run;
            if (tr) {
                let content = tr.content || '';
                const style = tr.text_element_style || {};
                if (style.inline_code) {
                    // 行内代码不允许嵌套样式
                    out += '`' + content + '`';
                    continue;
                }
                // 内部字符若包含 markdown 元字符，做最小转义
                content = content.replace(/([\\`*_{}\[\]()#+\-.!|<>])/g, '\\$1');
                if (style.bold) { content = `**${content}**`; }
                if (style.italic) { content = `*${content}*`; }
                if (style.strikethrough) { content = `~~${content}~~`; }
                if (style.underline) { content = `<u>${content}</u>`; }
                if (style.link && style.link.url) {
                    try {
                        content = `[${content}](${decodeURIComponent(style.link.url)})`;
                    } catch {
                        content = `[${content}](${style.link.url})`;
                    }
                }
                out += content;
                continue;
            }
            if (el.mention_doc?.url) {
                const url = el.mention_doc.url;
                const title = el.mention_doc.title || url;
                out += `[${title}](${url})`;
                continue;
            }
            if (el.equation?.content) {
                out += '$' + el.equation.content.trim() + '$';
                continue;
            }
        }
        return out;
    }

    /**
     * 飞书代码块语言 enum（int）→ Markdown 语言标记。
     */
    private static readonly CODE_LANG_BY_INT: Record<number, string> = {
        1: '', 2: 'abap', 3: 'ada', 4: 'apache', 5: 'apex', 6: 'asm', 7: 'bash',
        8: 'csharp', 9: 'cpp', 10: 'c', 11: 'cobol', 12: 'css', 13: 'coffeescript',
        14: 'd', 15: 'dart', 16: 'delphi', 17: 'django', 18: 'dockerfile', 19: 'erlang',
        20: 'fortran', 21: 'foxpro', 22: 'go', 23: 'groovy', 24: 'html', 25: 'htmlbars',
        26: 'http', 27: 'haskell', 28: 'json', 29: 'java', 30: 'javascript', 31: 'julia',
        32: 'kotlin', 33: 'latex', 34: 'lisp', 35: 'logo', 36: 'lua', 37: 'matlab',
        38: 'makefile', 39: 'markdown', 40: 'nginx', 41: 'objective-c', 42: 'openedgeabl',
        43: 'php', 44: 'perl', 45: 'postscript', 46: 'powershell', 47: 'prolog',
        48: 'protobuf', 49: 'python', 50: 'r', 51: 'rpg', 52: 'ruby', 53: 'rust',
        54: 'sas', 55: 'scss', 56: 'sql', 57: 'scala', 58: 'scheme', 59: 'scratch',
        60: 'shell', 61: 'swift', 62: 'thrift', 63: 'typescript', 64: 'vbscript',
        65: 'vb', 66: 'xml', 67: 'yaml', 68: 'cmake', 69: 'diff', 70: 'gherkin',
        71: 'graphql', 72: 'glsl', 73: 'properties', 74: 'solidity', 75: 'toml'
    };

    /**
     * 渲染单个 block 为 Markdown 文本。返回 null 表示该块本身不产生文本（容器块由调用方负责递归子块）。
     */
    private renderBlock(
        block: any,
        blockMap: Map<string, any>,
        orderedCounters: Map<string, number>,
        indent: string
    ): string | null {
        const t = block.block_type;
        // Page 块没有自身文本，交给调用方递归
        if (t === 1) { return null; }

        // 文本
        if (t === 2 && block.text) {
            return indent + this.renderElements(block.text.elements);
        }
        // 标题 1~9（block_type 3..11 对应 heading1..heading9）
        if (t >= 3 && t <= 11) {
            const level = t - 2;
            const field = `heading${level}`;
            const node = block[field];
            const hashes = '#'.repeat(level);
            return `${hashes} ${this.renderElements(node?.elements)}`;
        }
        // 无序列表
        if (t === 12 && block.bullet) {
            return `${indent}- ${this.renderElements(block.bullet.elements)}`;
        }
        // 有序列表
        if (t === 13 && block.ordered) {
            const parentKey = `${block.parent_id || ''}|${indent.length}`;
            const seq = block.ordered.style?.sequence;
            let num: number;
            if (seq && seq !== 'auto' && /^\d+$/.test(seq)) {
                num = parseInt(seq, 10);
            } else {
                num = (orderedCounters.get(parentKey) || 0) + 1;
            }
            orderedCounters.set(parentKey, num);
            return `${indent}${num}. ${this.renderElements(block.ordered.elements)}`;
        }
        // 代码块
        if (t === 14 && block.code) {
            const langInt = block.code.style?.language;
            const lang = (langInt && FeishuApi.CODE_LANG_BY_INT[langInt]) || '';
            const content = (block.code.elements || [])
                .map((e: any) => e.text_run?.content || '')
                .join('');
            return '```' + lang + '\n' + content + '\n```';
        }
        // 引用
        if (t === 15 && block.quote) {
            return `> ${this.renderElements(block.quote.elements)}`;
        }
        // 待办
        if (t === 17 && block.todo) {
            const checked = block.todo.style?.done ? 'x' : ' ';
            return `${indent}- [${checked}] ${this.renderElements(block.todo.elements)}`;
        }
        // 高亮块（callout）—— 渲染为引用形式
        if (t === 19 && block.callout) {
            return `> ${this.renderElements(block.callout.elements)}`;
        }
        // 分割线
        if (t === 22) {
            return '---';
        }
        // 图片
        if (t === 27 && block.image) {
            const token = block.image.token || '';
            return `![image](${token})`;
        }
        // 表格容器本身不产生行，由专用渲染处理
        if (t === 31 && block.table) {
            return this.renderTable(block, blockMap);
        }
        // 表格单元格 / 行 / 分栏等纯容器
        if (t === 32 || t === 24 || t === 25 || t === 34) {
            return null;
        }

        // 兜底：尝试从任意子结构里抽出 elements
        for (const key of Object.keys(block)) {
            const v = block[key];
            if (v && Array.isArray(v.elements)) {
                const text = this.renderElements(v.elements);
                if (text) { return indent + text; }
            }
        }
        return null;
    }

    /**
     * 渲染表格块。飞书表格是 block_type=31，内部按 row_size × column_size 顺序排列了 block_type=32 的单元格。
     */
    private renderTable(tableBlock: any, blockMap: Map<string, any>): string {
        const property = tableBlock.table?.property || {};
        const rows = property.row_size || 0;
        const cols = property.column_size || 0;
        const cellIds: string[] = tableBlock.children || [];
        if (!rows || !cols || cellIds.length < rows * cols) {
            return '';
        }
        const lines: string[] = [];
        for (let r = 0; r < rows; r++) {
            const cellTexts: string[] = [];
            for (let c = 0; c < cols; c++) {
                const cellId = cellIds[r * cols + c];
                const cellBlock = blockMap.get(cellId);
                let text = '';
                if (cellBlock?.children) {
                    const parts: string[] = [];
                    for (const childId of cellBlock.children) {
                        const child = blockMap.get(childId);
                        if (!child) { continue; }
                        const rendered = this.renderBlock(child, blockMap, new Map(), '');
                        if (rendered !== null) {
                            parts.push(rendered.replace(/\n+/g, ' '));
                        }
                    }
                    text = parts.join(' ').trim();
                }
                cellTexts.push(text.replace(/\|/g, '\\|'));
            }
            lines.push('| ' + cellTexts.join(' | ') + ' |');
            if (r === 0) {
                lines.push('| ' + Array(cols).fill('---').join(' | ') + ' |');
            }
        }
        return lines.join('\n');
    }

    /**
     * 递归把一个块及其子块拼成 Markdown。
     */
    private walkBlocks(
        rootChildren: string[] | undefined,
        blockMap: Map<string, any>,
        indent: string,
        orderedCounters: Map<string, number>
    ): string {
        if (!rootChildren || !rootChildren.length) { return ''; }
        const out: string[] = [];
        let prevWasList = false;
        for (const id of rootChildren) {
            const block = blockMap.get(id);
            if (!block) { continue; }
            // 表格容器自己已经会把所有单元格渲染掉，不要再递归它的 children
            const isTable = block.block_type === 31;
            const rendered = this.renderBlock(block, blockMap, orderedCounters, indent);
            const isList = block.block_type === 12 || block.block_type === 13 || block.block_type === 17;
            if (rendered !== null && rendered !== '') {
                // 块之间空行分隔；同级连续的列表项之间不留空行
                if (out.length && !(prevWasList && isList)) {
                    out.push('');
                }
                out.push(rendered);
                prevWasList = isList;
            }
            // 子块递归（容器或带子内容的列表项 / 标题等）
            if (!isTable && block.children && block.children.length) {
                const childIndent = isList ? indent + '  ' : indent;
                const childMd = this.walkBlocks(block.children, blockMap, childIndent, orderedCounters);
                if (childMd) {
                    out.push(childMd);
                    prevWasList = false;
                }
            }
        }
        return out.join('\n');
    }

    /**
     * 从 docx blocks 拉取并转换为 Markdown。
     */
    private async convertBlocksToMarkdown(documentId: string): Promise<string> {
        const items = await this.fetchAllBlocks(documentId);
        if (!items.length) { return ''; }

        const blockMap = new Map<string, any>();
        for (const b of items) {
            if (b.block_id) { blockMap.set(b.block_id, b); }
        }
        const root = items.find((b: any) => b.block_type === 1) || items[0];
        const md = this.walkBlocks(root.children, blockMap, '', new Map());
        return md.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    }

    /**
     * 将 Markdown 转换为飞书文档块结构
     */
    private markdownToBlocks(markdown: string): Array<any> {
        const lines = markdown.split('\n');
        const blocks: Array<any> = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            // 跳过空行
            if (!line.trim()) {
                i++;
                continue;
            }

            // 标题 (# ## ### ...)
            const headingMatch = line.match(/^(#{1,9})\s+(.+)$/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                const text = headingMatch[2];
                const elements = this.parseInlineStyles(text);

                const block: any = {
                    block_type: 2 + level, // 3=h1, 4=h2, ..., 11=h9
                };

                const fieldName = `heading${level}`;
                block[fieldName] = {
                    style: { align: 1, folded: false },
                    elements
                };

                blocks.push(block);
                i++;
                continue;
            }

            // 代码块 (```language ... ```)
            const fenceMatch = line.match(/^```([^\s`]*)\s*$/);
            if (fenceMatch) {
                const langName = fenceMatch[1] || '';
                const codeLines: string[] = [];
                i++;
                while (i < lines.length && !/^```\s*$/.test(lines[i])) {
                    codeLines.push(lines[i]);
                    i++;
                }
                const languageInt = this.getLanguageCode(langName);
                blocks.push({
                    block_type: 14, // 代码块
                    code: {
                        style: { language: languageInt, wrap: true },
                        elements: [{
                            text_run: {
                                content: codeLines.join('\n'),
                                text_element_style: {}
                            }
                        }]
                    }
                });
                if (i < lines.length) { i++; } // 跳过结束 ```
                continue;
            }

            // 引用块 (> text)
            const quoteMatch = line.match(/^>\s+(.+)$/);
            if (quoteMatch) {
                const text = quoteMatch[1];
                const elements = this.parseInlineStyles(text);
                blocks.push({
                    block_type: 15, // 引用块
                    quote: {
                        style: { align: 1, folded: false },
                        elements
                    }
                });
                i++;
                continue;
            }

            // 无序列表 (- item 或 * item)
            const bulletMatch = line.match(/^[-*]\s+(.+)$/);
            if (bulletMatch) {
                const text = bulletMatch[1];
                const elements = this.parseInlineStyles(text);
                blocks.push({
                    block_type: 12, // 无序列表
                    bullet: {
                        style: { align: 1, folded: false },
                        elements
                    }
                });
                i++;
                continue;
            }

            // 有序列表 (1. item)
            const orderedMatch = line.match(/^(\d+)\.\s+(.+)$/);
            if (orderedMatch) {
                const num = orderedMatch[1];
                const text = orderedMatch[2];
                const elements = this.parseInlineStyles(text);

                // 判断是开始新列表(1)还是继续编号(auto)
                const sequence = num === '1' ? '1' : 'auto';

                blocks.push({
                    block_type: 13, // 有序列表
                    ordered: {
                        style: {
                            align: 1,
                            folded: false,
                            sequence
                        },
                        elements
                    }
                });
                i++;
                continue;
            }

            // 普通文本（支持行内样式）
            const elements = this.parseInlineStyles(line);
            blocks.push({
                block_type: 2, // 文本块
                text: {
                    style: { align: 1, folded: false },
                    elements
                }
            });
            i++;
        }

        // 如果没有任何块，添加一个空文本块
        if (blocks.length === 0) {
            blocks.push({
                block_type: 2,
                text: {
                    style: { align: 1, folded: false },
                    elements: [{
                        text_run: {
                            content: ' ',
                            text_element_style: {}
                        }
                    }]
                }
            });
        }

        return blocks;
    }

    /**
     * 解析 Markdown 行内样式（加粗、斜体、删除线、行内代码、链接）
     */
    private parseInlineStyles(text: string): Array<any> {
        const elements: Array<any> = [];
        let currentPos = 0;

        // 正则匹配各种行内样式
        // 顺序：链接 > 加粗 > 斜体 > 删除线 > 行内代码
        const pattern = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(__([^_]+)__)|(_([^_]+)_)|(~~([^~]+)~~)|(`([^`]+)`)/g;

        let match: RegExpExecArray | null;

        while ((match = pattern.exec(text)) !== null) {
            // 添加匹配前的普通文本
            if (match.index > currentPos) {
                const plainText = text.substring(currentPos, match.index);
                if (plainText) {
                    elements.push({
                        text_run: {
                            content: plainText,
                            text_element_style: {}
                        }
                    });
                }
            }

            // 链接 [text](url)
            if (match[1]) {
                elements.push({
                    text_run: {
                        content: match[2],
                        text_element_style: {
                            link: { url: encodeURI(match[3]) }
                        }
                    }
                });
            }
            // 加粗 **text** 或 __text__
            else if (match[4] || match[8]) {
                elements.push({
                    text_run: {
                        content: match[5] || match[9],
                        text_element_style: { bold: true }
                    }
                });
            }
            // 斜体 *text* 或 _text_
            else if (match[6] || match[10]) {
                elements.push({
                    text_run: {
                        content: match[7] || match[11],
                        text_element_style: { italic: true }
                    }
                });
            }
            // 删除线 ~~text~~
            else if (match[12]) {
                elements.push({
                    text_run: {
                        content: match[13],
                        text_element_style: { strikethrough: true }
                    }
                });
            }
            // 行内代码 `code`
            else if (match[14]) {
                elements.push({
                    text_run: {
                        content: match[15],
                        text_element_style: { inline_code: true }
                    }
                });
            }

            currentPos = match.index + match[0].length;
        }

        // 添加剩余的普通文本
        if (currentPos < text.length) {
            const remainingText = text.substring(currentPos);
            if (remainingText) {
                elements.push({
                    text_run: {
                        content: remainingText,
                        text_element_style: {}
                    }
                });
            }
        }

        // 如果没有任何元素，返回空文本
        if (elements.length === 0) {
            elements.push({
                text_run: {
                    content: text || ' ',
                    text_element_style: {}
                }
            });
        }

        return elements;
    }

    /**
     * 将 Markdown 代码块语言标识映射到飞书的 language 枚举（int）。
     */
    private getLanguageCode(language: string): number {
        const languageMap: Record<string, number> = {
            'plaintext': 1,
            'plain': 1,
            'text': 1,
            'abap': 2,
            'ada': 3,
            'apache': 4,
            'apex': 5,
            'assembly': 6,
            'asm': 6,
            'bash': 7,
            'sh': 7,
            'csharp': 8,
            'cs': 8,
            'c#': 8,
            'c++': 9,
            'cpp': 9,
            'c': 10,
            'cobol': 11,
            'css': 12,
            'coffeescript': 13,
            'coffee': 13,
            'd': 14,
            'dart': 15,
            'delphi': 16,
            'pascal': 16,
            'django': 17,
            'dockerfile': 18,
            'docker': 18,
            'erlang': 19,
            'fortran': 20,
            'foxpro': 21,
            'go': 22,
            'golang': 22,
            'groovy': 23,
            'html': 24,
            'htmlbars': 25,
            'http': 26,
            'haskell': 27,
            'json': 28,
            'java': 29,
            'javascript': 30,
            'js': 30,
            'julia': 31,
            'kotlin': 32,
            'kt': 32,
            'latex': 33,
            'tex': 33,
            'lisp': 34,
            'logo': 35,
            'lua': 36,
            'matlab': 37,
            'makefile': 38,
            'make': 38,
            'markdown': 39,
            'md': 39,
            'nginx': 40,
            'objective-c': 41,
            'objectivec': 41,
            'objc': 41,
            'openedgeabl': 42,
            'php': 43,
            'perl': 44,
            'postscript': 45,
            'powershell': 46,
            'ps1': 46,
            'prolog': 47,
            'protobuf': 48,
            'proto': 48,
            'python': 49,
            'py': 49,
            'r': 50,
            'rpg': 51,
            'ruby': 52,
            'rb': 52,
            'rust': 53,
            'rs': 53,
            'sas': 54,
            'scss': 55,
            'sass': 55,
            'sql': 56,
            'scala': 57,
            'scheme': 58,
            'scratch': 59,
            'shell': 60,
            'swift': 61,
            'thrift': 62,
            'typescript': 63,
            'ts': 63,
            'vbscript': 64,
            'vbs': 64,
            'visual basic': 65,
            'vb': 65,
            'xml': 66,
            'yaml': 67,
            'yml': 67,
            'cmake': 68,
            'diff': 69,
            'patch': 69,
            'gherkin': 70,
            'graphql': 71,
            'gql': 71,
            'glsl': 72,
            'properties': 73,
            'solidity': 74,
            'sol': 74,
            'toml': 75
        };

        return languageMap[language.toLowerCase()] || 1; // 默认为纯文本
    }

    /**
     * 使用飞书官方 API 将 Markdown 转换为文档块
     */
    async convertMarkdownToBlocks(markdown: string): Promise<any> {
        console.log('[convertMarkdownToBlocks] 开始转换 Markdown，长度:', markdown.length);
        console.log('[convertMarkdownToBlocks] Markdown 内容预览:', markdown.substring(0, 200));

        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/open-apis/docx/v1/documents/blocks/convert`,
                {
                    content_type: 'markdown',
                    content: markdown
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log('[convertMarkdownToBlocks] API 响应状态:', response.status);
            console.log('[convertMarkdownToBlocks] API 响应 code:', response.data.code);

            if (response.data.code !== 0) {
                console.error('[convertMarkdownToBlocks] 转换失败 code:', response.data.code);
                console.error('[convertMarkdownToBlocks] 转换失败 msg:', response.data.msg);
                console.error('[convertMarkdownToBlocks] 完整响应:', JSON.stringify(response.data, null, 2));
                throw new Error(`Markdown 转换失败 (code: ${response.data.code}): ${response.data.msg || '未知错误'}`);
            }

            const blocks = response.data.data?.blocks || [];
            console.log('[convertMarkdownToBlocks] 转换成功，块数量:', blocks.length);

            if (blocks.length > 0) {
                console.log('[convertMarkdownToBlocks] 第一个块类型:', blocks[0].block_type);
            }

            return response.data.data;
        } catch (error: any) {
            console.error('[convertMarkdownToBlocks] 请求异常:', error.message);
            if (error.response) {
                console.error('[convertMarkdownToBlocks] 响应状态:', error.response.status);
                console.error('[convertMarkdownToBlocks] 响应数据:', JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }
    }

    /**
     * 删除所有子块并重新创建（全量更新方式）- 使用飞书官方 Markdown 转换 API
     */
    async replaceDocumentContent(documentId: string, content: string): Promise<void> {
        console.log('[replaceDocumentContent] 开始更新文档:', documentId);
        console.log('[replaceDocumentContent] 内容长度:', content.length);

        // 1. 获取文档的根块 ID
        const blocks = await this.getDocumentBlocks(documentId);
        console.log('[replaceDocumentContent] 获取到块数量:', blocks.items?.length || 0);

        const rootBlock = blocks.items.find((b: any) => b.block_type === 1); // 1 = page 类型

        if (!rootBlock) {
            throw new Error('无法找到文档根块');
        }

        console.log('[replaceDocumentContent] 根块 ID:', rootBlock.block_id);

        // 2. 删除所有子块
        const children = blocks.items.filter((b: any) => b.parent_id === rootBlock.block_id);
        console.log('[replaceDocumentContent] 需要删除的子块数量:', children.length);

        if (children.length > 0) {
            await axios.delete(
                `${this.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${rootBlock.block_id}/children/batch_delete`,
                {
                    data: {
                        start_index: 0,
                        end_index: children.length
                    },
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log('[replaceDocumentContent] 子块删除成功');
        }

        // 3. 将 Markdown 转换为飞书文档块（使用内置转换，不需要额外权限）
        console.log('[replaceDocumentContent] 使用内置方法转换 Markdown 到文档块');

        try {
            // 使用内置的 Markdown 解析方法
            let convertedBlocks = this.markdownToBlocks(content);

            console.log('[replaceDocumentContent] 转换得到', convertedBlocks.length, '个块');

            if (convertedBlocks.length === 0) {
                console.warn('[replaceDocumentContent] 转换后没有生成任何块，插入空文本块');
                convertedBlocks.push({
                    block_type: 2,
                    text: {
                        elements: [{
                            text_run: {
                                content: ' '
                            }
                        }]
                    }
                });
            }

            console.log('[replaceDocumentContent] 准备插入的块数量:', convertedBlocks.length);

            // 打印前几个块的结构，用于调试
            if (convertedBlocks.length > 0) {
                console.log('[replaceDocumentContent] 前3个块的结构:', JSON.stringify(convertedBlocks.slice(0, 3), null, 2));
            }

            // 插入转换后的块
            const insertResponse = await axios.post(
                `${this.apiBaseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${rootBlock.block_id}/children`,
                {
                    children: convertedBlocks
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log('[replaceDocumentContent] 插入响应状态:', insertResponse.status);
            console.log('[replaceDocumentContent] 插入响应 code:', insertResponse.data.code);

            if (insertResponse.data.code !== 0) {
                console.error('[replaceDocumentContent] API 返回错误代码:', insertResponse.data.code);
                console.error('[replaceDocumentContent] 错误消息:', insertResponse.data.msg);
                console.error('[replaceDocumentContent] 完整响应:', JSON.stringify(insertResponse.data, null, 2));
                throw new Error(`飞书 API 错误 ${insertResponse.data.code}: ${insertResponse.data.msg}`);
            }

            console.log('[replaceDocumentContent] 文档块插入成功');
        } catch (error: any) {
            console.error('[replaceDocumentContent] 创建失败:', error.message);
            if (error.response?.data) {
                console.error('[replaceDocumentContent] 错误响应:', JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }

        console.log('[replaceDocumentContent] 更新完成');
    }
}

export { extractDocTokenFromUrl };