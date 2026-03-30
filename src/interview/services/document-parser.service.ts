import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import pdfParse from 'pdf-parse';
import * as mammoth from 'mammoth';

/**
 * 文档解析服务
 * 支持从 URL 下载并解析 PDF、DOCX 等格式的简历文件
 */
@Injectable()
export class DocumentParserService {
  private readonly logger = new Logger(DocumentParserService.name);

  // 支持的文本类型
  private readonly SUPPORTED_TYPES = {
    PDF: ['.pdf'],
    DOCX: ['.docx', '.doc'],
  };
  // 最大文件大小（10MB）
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024;

  /**
   * 从 URL 下载并解析文档
   * @param url - 文档的 URL（阿里云OSS等）
   * @returns 解析后的文本内容
   */
  async parseDocumentFromUrl(url: string): Promise<string> {
    try {
      this.logger.log(`开始解析文档：${url}`);
      // 1.验证URL
      this.validateUrl(url);
      // 2.下载文件
      const buffer = await this.downloadFile(url);
      // 3.根据文件类型解析
      const fileType = this.getFileType(url);
      let text: string;

      switch (fileType) {
        case 'PDF':
          text = await this.parsePdf(buffer);
          break;
        case 'DOCX':
          text = await this.parseDocx(buffer);
          break;
        default:
          throw new BadRequestException(
            `不支持的文件格式。当前仅支持：PDF，DOCX`,
          );
      }
      this.logger.log(`文档解析完成，长度=${text.length}字符`);
      return text;
    } catch (error: unknown) {
      const err = error as { message?: string; stack?: string };
      this.logger.error(`文档解析失败：${err.message}`, err.stack);
      throw error;
    }
  }
  /**
   * 验证URL
   * @param url
   */
  private validateUrl(url: string): void {
    if (!url) {
      throw new BadRequestException('URL不能为空');
    }
    try {
      new URL(url);
    } catch {
      throw new BadRequestException('无效的URL');
    }
    // 检查文件扩展名
    const fileType = this.getFileType(url);
    if (!fileType) {
      throw new BadRequestException(
        `不支持的文件格式。支持的格式： ${Object.values(this.SUPPORTED_TYPES).flat().join(', ')}`,
      );
    }
  }
  /**
   * 获取文件类型
   * @param url
   */
  private getFileType(url: string): 'PDF' | 'DOCX' | null {
    const urlLower = url.toLowerCase();

    for (const [type, extensions] of Object.entries(this.SUPPORTED_TYPES)) {
      for (const ext of extensions) {
        if (urlLower.includes(ext)) {
          return type as 'PDF' | 'DOCX';
        }
      }
    }
    return null;
  }
  /**
   * 下载文件
   * @param url
   * @returns
   */
  private async downloadFile(url: string): Promise<Buffer> {
    try {
      this.logger.log(`开始下载文件：${url}`);
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30 * 1000,
        maxContentLength: this.MAX_FILE_SIZE,
        maxBodyLength: this.MAX_FILE_SIZE,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ResumeParser/1.0)',
        },
      });
      const buffer = Buffer.from(response.data);
      // 验证文件大小
      if (buffer.length > this.MAX_FILE_SIZE) {
        throw new BadRequestException(
          `文件大小超出限制, ${(buffer.length / 1024 / 1024).toFixed(2)}MB, 最大支持10MB`,
        );
      }
      // 验证文件内容不为空
      if (buffer.length === 0) {
        throw new BadRequestException('文件内容为空');
      }
      this.logger.log(
        `文件下载完成，大小=${(buffer.length / 1024).toFixed(2)}kb`,
      );
      return buffer;
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const axiosError = error as {
        code?: string;
        response?: { status?: number };
        message?: string;
      };
      if (axiosError.code === 'ECONNABORTED') {
        throw new BadRequestException('文件下载超时');
      }
      if (axiosError.response?.status === 404) {
        throw new BadRequestException('文件未找到');
      }
      if (axiosError.response?.status === 403) {
        throw new BadRequestException('文件访问被拒绝');
      }
      throw new BadRequestException(
        `文件下载失败, ${axiosError.message || '未知错误'} `,
      );
    }
  }
  /**
   * 解析PDF文件
   * @param buffer
   */
  private async parsePdf(buffer: Buffer): Promise<string> {
    try {
      this.logger.log('开始解析PDF文件');
      const data = await pdfParse(buffer);
      if (!data.text || data.text.trim().length === 0) {
        throw new BadRequestException(
          'PDF 文件无法提取文本内容。可能原因' +
            '\n1. PDF 是图片格式（需要OCR）' +
            '\n2. PDF 已加密或受保护' +
            '\n3. PDF 文件损坏',
        );
      }
      this.logger.log(
        `PDF文件解析完成: 页数=${data.numpages}，文本长度=${data.text.length}字符`,
      );
      return data.text;
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const err = error as { message?: string; stack?: string };
      this.logger.error(`PDF文件解析失败：${err.message}`, err.stack);
      throw new BadRequestException(
        `PDF文件解析失败: ${err.message}。请确保文件未加密且未损坏`,
      );
    }
  }
  /**
   * 解析DOCX文件
   * @param buffer
   */
  private async parseDocx(buffer: Buffer): Promise<string> {
    try {
      this.logger.log('开始解析DOCX文件');
      // 使用 mammoth 提取纯文本内容
      const result = await mammoth.extractRawText({ buffer });
      if (!result.value || result.value.trim().length === 0) {
        throw new BadRequestException(
          'DOCX 文件无法提取文本内容。可能原因' +
            '\n1. DOCX 文件为空' +
            '\n2. DOCX 文件格式不挣钱' +
            '\n3. DOCX 文件损坏',
        );
      }
      // 如果解析过程中有任何警告信息，记录这些警告
      if (result.messages && result.messages.length > 0) {
        this.logger.warn(
          `DOCX文件解析警告：${result.messages.map((m) => m.message).join('\n')}`,
        );
      }
      this.logger.log(`DOCX文件解析完成，文本长度=${result.value.length}字符`);
      return result.value;
    } catch (error: unknown) {
      // 如果是已知错误，直接抛出
      if (error instanceof BadRequestException) {
        throw error;
      }
      // 其他错误记录详细日志并抛出通用错误提示
      const err = error as { message?: string };
      this.logger.error(`DOCX文件解析失败：${err.message}`);
      throw new BadRequestException(
        `DOCX文件解析失败: ${err.message}。请确保文件未损坏`,
      );
    }
  }
  /**
   * 清理文本内容
   * 去除多余的空白、特殊字符等
   */
  cleanText(text: string): string {
    if (!text) {
      return '';
    }
    return (
      text
        // 1.统一换行符
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // 去除文字中间的多余空格
        .replace(/\s+/g, ' ')
        // 2. 去除多余的空行（保留最多2个连续换行）
        .replace(/\n{3,}/g, '\n\n')
        // 3.去除行首行尾空白
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        // 4.去除特殊的 Unicode 控制字符
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        // 5.统一空格（去除多余空格）
        .replace(/ {2, }/g, ' ')
        // 6. 去除页眉页脚常见标记
        .replace(/第\s*\d+\s*页/g, '')
        .replace(/Page\s+\d+/gi, '')
        // 7.整体 trim
        .trim()
    );
  }
  estimateTokens(text: string): number {
    if (!text) {
      return 0;
    }
    // 统计中文字符数
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    // 统计英文单词数（粗略）
    const englishWords = (text.match(/\b\w+\b/g) || []).length;
    // 其他字符
    const otherChars = text.length - chineseChars - englishWords;
    // 预估token
    const chineseTokens = chineseChars / 1.5; // 每个中文字符
    const englishTokens = englishWords; // 每个英文单词
    const otherTokens = otherChars / 4; // 其他字符
    return Math.ceil(chineseTokens + englishTokens + otherTokens);
  }
  /**
   * 验证文本内容质量
   * 检查文本是否符合简历的基本特征
   * @param text
   */
  validateResumeContent(text: string): {
    isValid: boolean;
    reason?: string;
    warning?: string[];
  } {
    const warnings: string[] = [];
    // 1.长度检查
    if (text.length < 100) {
      return {
        isValid: false,
        reason: '简历内容过短（少于100字符），可能解析不完整',
      };
    }
    if (text.length > 20000) {
      warnings.push(`简历内容过长${text.length}字符，可能影响处理速度`);
    }
    // 2.关键信息检查（至少包含部分常见简历关键词）
    const requiredKeywords = [
      // 个人信息
      '姓名',
      '性别',
      '年龄',
      '手机',
      '电话',
      '邮箱',
      'email',
      '微信',
      // 教育经历
      '教育',
      '学历',
      '毕业',
      '大学',
      '学院',
      '专业',
      // 工作经历
      '工作',
      '经验',
      '项目',
      '公司',
      '职位',
      '岗位',
      // 技能
      '技能',
      '能力',
      '掌握',
      '熟悉',
      '精通',
    ];
    const foundKeywords = requiredKeywords.filter((keyword) =>
      text.includes(keyword),
    ).length;
    if (foundKeywords < 3) {
      warnings.push(
        `简历内容可能缺少关键信息，包含关键词：${requiredKeywords.join(', ')}`,
      );
    }
    // 3.格式检查
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 5) {
      warnings.push(`简历内容可能缺少格式，建议包含至少5行内容`);
    }
    return {
      isValid: true,
      warning: warnings.length > 0 ? warnings : undefined,
    };
  }
}
