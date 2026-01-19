import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { QrCodeStatus, QrCodeState } from './dto/wechat.dto';
import { Logger } from '@nestjs/common';
import { buildTextReply, buildImageReply } from './utils/wechat';
import { User, UserDocument } from '../user/schemas/user.schema';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class WechatService {
  private readonly logger = new Logger(WechatService.name);
  private qrCodeStore = new Map<string, QrCodeState>();
  /**
   * 当前缓存的微信 access_token
   * - 存储在内存中
   * - 仅在服务进程生命周期内有效
   * - 用于减少频繁调用微信接口获取 token
   */
  private accessToken: string = '';

  /**
   * access_token 的过期时间戳（毫秒）
   * - 由 expires_in 计算得出
   * - 在获取 token 时会预留安全时间，提前失效
   * - 与 accessToken 配合，用于判断缓存是否仍然可用
   */
  private expiresAt: number = 0;

  /**
   * 微信公众号 / 微信开放平台相关配置
   * 实际生产环境中应通过环境变量注入，避免敏感信息硬编码
   */
  private readonly wechatConfig = {
    /**
     * 微信 AppID
     * 用于标识当前公众号 / 应用的唯一身份
     * 在获取 access_token、创建二维码等接口中必需
     */
    appId: process.env.WECHAT_APP_ID || 'your_app_id',

    /**
     * 微信 AppSecret
     * 与 AppID 配对使用的密钥
     * 用于服务端换取 access_token，必须严格保密
     */
    appSecret: process.env.WECHAT_APP_SECRET || 'your_app_secret',

    /**
     * 微信授权回调地址
     * 用于 OAuth 授权流程，在用户同意授权后跳转回业务系统
     * 需要在微信公众平台后台进行白名单配置
     */
    redirectUri:
      process.env.WECHAT_REDIRECT_URI ||
      'https://lgdsunday.club/wechat/callback',

    /**
     * 服务器配置中的 Token
     * 用于微信服务器与业务服务器之间的签名校验
     * 主要应用于消息推送与服务器验证场景
     */
    token: process.env.WECHAT_TOKEN || 'your_token',

    /**
     * 消息加解密密钥 EncodingAESKey
     * 用于对微信推送的消息进行 AES 加解密
     * 在开启“安全模式”或“兼容模式”时必须配置
     */
    encodingAESKey:
      process.env.WECHAT_ENCODING_AES_KEY || 'your_encoding_aes_key',
  };

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 生成用于微信扫码登录的二维码
   * @returns 二维码地址、二维码唯一 ID、过期时间
   */
  async generateLoginQrCode(): Promise<{
    qrCodeUrl: string;
    qrCodeId: string;
    expireTime: number;
  }> {
    // 生成二维码唯一标识
    // 使用时间戳 + 随机字符串，避免并发场景下 ID 冲突
    const qrCodeId = `qr_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 计算二维码过期时间（5 分钟后）
    // 该时间用于服务端校验二维码是否失效
    const expireTime = Date.now() + 5 * 60 * 1000;

    /**
     * 第一步：获取微信 access_token
     * access_token 是调用微信开放 API 的全局凭证
     */
    const tokenRes = await axios.get(
      'https://api.weixin.qq.com/cgi-bin/token',
      {
        params: {
          grant_type: 'client_credential',
          appid: this.wechatConfig.appId,
          secret: this.wechatConfig.appSecret,
        },
      },
    );

    // 从响应中读取 access_token
    const accessToken = tokenRes.data.access_token;

    // access_token 获取失败时，直接中断流程并抛出错误
    if (!accessToken) {
      throw new Error(
        `获取 access_token 失败: ${JSON.stringify(tokenRes.data)}`,
      );
    }

    /**
     * 第二步：创建临时二维码
     * 使用字符串场景值（scene_str）绑定二维码与登录状态
     */
    const createRes = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${accessToken}`,
      {
        // 二维码有效期，单位：秒
        expire_seconds: 300,
        action_name: 'QR_STR_SCENE',
        action_info: {
          scene: {
            // scene_str 用于在扫码回调时识别是哪一个二维码
            scene_str: qrCodeId,
          },
        },
      },
    );

    // 校验二维码 ticket 是否生成成功
    if (!createRes.data.ticket) {
      throw new Error(`生成二维码失败: ${JSON.stringify(createRes.data)}`);
    }

    // 微信返回的二维码票据
    const ticket = createRes.data.ticket;

    // 根据 ticket 拼接最终可访问的二维码图片地址
    const qrCodeUrl = `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(
      ticket,
    )}`;

    /**
     * 第三步：在服务端缓存二维码状态
     * 用于后续扫码回调、轮询登录状态等流程
     */
    this.qrCodeStore.set(qrCodeId, {
      id: qrCodeId,
      openid: '', // 用户扫码后会写入对应的 openid
      status: QrCodeStatus.PENDING, // 初始状态：未扫码
      expireTime, // 过期时间
      createdAt: Date.now(), // 创建时间
    });

    // 返回前端所需的二维码信息
    return {
      qrCodeUrl,
      qrCodeId,
      expireTime,
    };
  }

  /**
   * 判断用户是否已经关注公众号
   */
  async markQrCodeScanned(wxParsed: any, openid: string): Promise<boolean> {
    try {
      // 检查 EventKey 是否存在
      if (!wxParsed.EventKey) {
        this.logger.warn('EventKey 为空，不是登录二维码');
        return false;
      }

      // 对于首次关注事件，eventKey 会是 'qrscene_xxx'
      const qrCodeId = wxParsed.EventKey.startsWith('qrscene_')
        ? wxParsed.EventKey.replace('qrscene_', '')
        : wxParsed.EventKey;

      const record = this.qrCodeStore.get(qrCodeId);
      if (!record) {
        // 不是登录二维码，返回 false
        this.logger.log(`二维码 ${qrCodeId} 不在登录队列中`);
        return false;
      }

      if (record.expireTime < Date.now()) {
        record.status = QrCodeStatus.EXPIRED;
        this.logger.warn(`二维码 ${qrCodeId} 已过期`);
      } else {
        record.username = wxParsed.ToUserName;
        record.status = QrCodeStatus.CONFIRMED;
        record.openid = openid;
        this.logger.log(`二维码 ${qrCodeId} 扫码成功, openid: ${openid}`);
      }

      this.qrCodeStore.set(qrCodeId, record);
      return true;
    } catch (error) {
      this.logger.error('markQrCodeScanned 处理失败:', error);
      return false;
    }
  }

  /**
   * 处理用户关注事件，返回欢迎消息
   */
  async handleSubscribe(wxParsed: any): Promise<string> {
    const welcomeMessage =
      '👋 您好，欢迎来到汪汪职道！我们为您提供专业的求职服务： 📝 简历优化 → 📚 笔试押题 → 📊 行测训练 → 💬 模拟面试 → 💰 薪资谈判 从简历到offer，全程护航您的求职之路！✨';

    return buildTextReply(wxParsed, welcomeMessage);
  }

  /**
   * 检查二维码状态
   */
  async getQrCodeStatus(qrCodeId: string): Promise<{
    status: QrCodeStatus;
    user?: any;
    token?: string;
  }> {
    const qrCodeState = this.qrCodeStore.get(qrCodeId);

    if (!qrCodeState) {
      return { status: QrCodeStatus.EXPIRED };
    }

    // 检查是否过期
    if (Date.now() > qrCodeState.expireTime) {
      this.qrCodeStore.delete(qrCodeId);
      return { status: QrCodeStatus.EXPIRED };
    }

    if (qrCodeState.status === QrCodeStatus.CONFIRMED && qrCodeState.openid) {
      // 获取用户信息并生成token
      const user = await this.findOrCreateWechatUser(qrCodeState.openid);
      const token = await this.generateJwt(user);

      // 清理二维码状态
      this.qrCodeStore.delete(qrCodeId);

      return {
        status: QrCodeStatus.CONFIRMED,
        user,
        token,
      };
    }

    return { status: qrCodeState.status };
  }

  /**
   * 查找或创建微信用户
   */
  async findOrCreateWechatUser(openid: string): Promise<User> {
    let user = await this.userModel.findOne({ openid }).exec();

    if (!user) {
      // 创建新用户
      const userData: Partial<User> = {
        openid,
        username: `旺旺-${Math.random().toString(36).slice(2, 8)}`, // 生成一个随机的名字
        phone: '', // 微信用户可能没有手机号
        isWechatBound: true,
        wechatBoundTime: new Date(),
        // 赠送 20 旺旺币
        wwCoinBalance: 20,
      };
      this.logger.log('创建新用户，赠送 20 旺旺币', userData);
      user = await this.userModel.create(userData);
    } else {
      // 修改 isWechatBound 为 true
      await user.updateOne({ isWechatBound: true });
    }

    return user;
  }

  /**
   * 生成JWT token
   * Token过期时间：下一个凌晨4点（48-72小时之间）
   */
  async generateJwt(user: User): Promise<string> {
    const id = (user as any)._id || (user as any).id;

    const token = this.jwtService.sign({
      sub: id,
      openid: user.openid,
      username: user.username,
      phone: user.phone,
    });

    // 记录token过期时间
    this.logger.log(`生成JWT Token: userId=${id}}`);

    return token;
  }

  /**
   * 获取微信 access_token（带本地缓存）
   * 说明：
   * - 优先从内存中读取未过期的 access_token
   * - 若不存在或已过期，则通过微信「stable_token」接口重新获取
   * - 获取成功后会更新本地缓存及过期时间
   */
  async getAccessToken(): Promise<string> {
    // 当前时间戳（毫秒）
    const now = Date.now();

    /**
     * 命中本地缓存：
     * - accessToken 已存在
     * - 当前时间仍小于过期时间
     * 直接返回缓存的 token，避免重复请求微信接口
     */
    if (this.accessToken && now < this.expiresAt) {
      return this.accessToken;
    }

    /**
     * 微信 stable_token 接口地址
     * 相比旧的 GET /cgi-bin/token：
     * - 支持更稳定的 token 管理
     * - 官方推荐在生产环境中使用
     */
    const url = 'https://api.weixin.qq.com/cgi-bin/stable_token';

    /**
     * 调用微信接口获取 access_token
     * 参数说明：
     * - appid / secret：公众号或小程序的凭证
     * - grant_type：固定为 client_credential
     * - force_refresh：是否强制刷新 token
     */
    const { data } = await axios.post(url, {
      appid: this.wechatConfig.appId,
      secret: this.wechatConfig.appSecret,
      grant_type: 'client_credential',
      force_refresh: false,
    });

    // 记录接口返回日志，方便排查问题
    this.logger.log('获取稳定版接口调用凭据，返回的 data:', data);

    /**
     * 成功获取 access_token
     */
    if (data.access_token) {
      // 缓存 access_token
      this.accessToken = data.access_token;

      /**
       * 计算过期时间：
       * - data.expires_in 单位为秒
       * - 提前 200 秒失效，防止临界时间点导致 token 过期
       */
      this.expiresAt = now + (data.expires_in - 200) * 1000;

      return this.accessToken;
    }

    /**
     * 未返回 access_token，直接抛出异常
     * 通常包含 errcode / errmsg
     */
    throw new Error('获取 access_token 失败: ' + JSON.stringify(data));
  }

  /**
   * 创建公众号自定义菜单
   * 功能说明：
   * - 通过微信接口创建公众号底部菜单栏
   * - 依赖 access_token 作为接口调用凭证
   * - 菜单配置采用 JSON 结构体提交给微信服务器
   */
  async createMenu() {
    /**
     * 获取 access_token
     * - 内部带缓存机制
     * - 若 token 未过期则直接返回缓存值
     * - 若过期则重新向微信服务器请求
     */
    const access_token = await this.getAccessToken();

    /**
     * 调用微信「创建自定义菜单」接口
     * 接口地址：
     * POST https://api.weixin.qq.com/cgi-bin/menu/create?access_token=ACCESS_TOKEN
     */
    const result = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/menu/create?access_token=${access_token}`,
      {
        /**
         * button：一级菜单数组（最多 3 个）
         * 每个按钮对象代表一个菜单项
         */
        button: [
          {
            /**
             * click 类型按钮：
             * - 用户点击后，微信服务器会推送事件到回调接口
             * - 通过 key 区分具体点击的是哪个菜单
             */
            type: 'click',
            name: '关于我们', // 菜单名称
            key: 'about_us', // 事件标识 key（用于后端事件分发处理）
          },

          /**
           * view 类型按钮示例（被注释）
           * - 点击后直接跳转到指定 URL
           */
          // {
          //   type: 'view',
          //   name: '关于我们',
          //   url: 'https://api.resume.lgdsunday.club/download/imgs/wechat.jpg',
          // },

          {
            /**
             * view 类型按钮：
             * - 点击后跳转到外部网页
             */
            type: 'view',
            name: '简历汪', // 菜单名称
            url: 'https://www.lgdsunday.club', // 跳转链接
          },
          {
            /**
             * view 类型按钮：
             * - 用于跳转到面试资源网站
             */
            type: 'view',
            name: '面试汪',
            url: 'https://www.mianshiwangoffer.com/',
          },
        ],
      },
    );

    /**
     * 返回微信接口响应数据
     * 成功示例：
     * { errcode: 0, errmsg: 'ok' }
     */
    return result.data;
  }

  /**
   * 处理文本消息
   */
  async handleTextMessage(xml: any) {
    let reply = '';
    if (xml.EventKey === 'about_us') {
      // 回复 sunday 的二维码
      const { media_id } = await this.uploadImage();
      reply = buildImageReply(xml, media_id);
    } else {
      reply = buildTextReply(xml, '暂时还未定义这个菜单行为');
    }
    return reply;
  }

  /**
   * 上传图片到微信服务器
   * 功能说明：
   * - 将本地图片上传至微信服务器
   * - 常用于公众号素材（临时素材）上传
   * - 返回 media_id，可用于消息发送或其他接口调用
   */
  async uploadImage() {
    // 记录上传流程开始日志
    this.logger.log('开始执行图片上传');

    /**
     * 获取 access_token
     * - 内部包含缓存与过期控制逻辑
     */
    const access_token = await this.getAccessToken();
    this.logger.log('access_token：', access_token);

    /**
     * 拼接本地图片的绝对路径
     * 目录结构示例：
     * /public/imgs/wechat.jpg
     */
    const filePath = path.join(
      __dirname,
      '..',
      '..',
      'public',
      'imgs',
      'wechat.jpg',
    );

    /**
     * 构建 multipart/form-data 请求体
     * - media 字段为微信接口规定的文件字段名
     * - 使用 fs.createReadStream 避免一次性加载大文件到内存
     */
    const form = new FormData();
    form.append('media', fs.createReadStream(filePath));

    /**
     * 调用微信「上传临时素材」接口
     * 接口说明：
     * - type=image 表示上传图片类型
     * - access_token 作为鉴权参数
     * - 需要携带 form-data 对应的 headers
     */
    const res = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${access_token}&type=image`,
      form,
      {
        headers: form.getHeaders(),
      },
    );

    /**
     * 返回微信服务器响应数据
     * 成功示例：
     * {
     *   type: 'image',
     *   media_id: 'MEDIA_ID',
     *   created_at: 123456789
     * }
     */
    return res.data;
  }

  /**
   * 删除公众号自定义菜单
   */
  async deleteMenu() {
    const access_token = await this.getAccessToken();
    const result = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/menu/delete?access_token=${access_token}`,
    );

    return result.data;
  }

  /**
   * 获取公众号自定义菜单
   */
  async getMenu() {
    const access_token = await this.getAccessToken();
    const result = await axios.get(
      `https://api.weixin.qq.com/cgi-bin/menu/get?access_token=${access_token}`,
    );

    return result.data;
  }
}
