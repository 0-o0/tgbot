import TelegramBot, { TelegramExecutionContext } from '../../main/src/main.js';
import { marked } from 'marked';

export interface Environment {
        SECRET_TELEGRAM_API_TOKEN: string;
        AI: Ai;
        DB: D1Database;
}

// 定义AI模型输出类型
interface AiTextGenerationOutput {
        response?: string;
        tool_calls?: Array<{ name: string; arguments: unknown }>;
        [key: string]: any;
}

// 定义LLAMA模型输出类型
interface Ai_Cf_Meta_Llama_3_2_11B_Vision_Instruct_Output {
        response?: string;
        tool_calls?: Array<{ name?: string; arguments?: object }>;
        [key: string]: any;
}

type promiseFunc<T> = (resolve: (result: T) => void, reject: (e?: Error) => void) => Promise<T>;

/**
 * Wrap setTimeout in a Promise
 * @param func - function to call after setTimeout
 * @param time - delay in milliseconds (default: 1000)
 */
function wrapPromise<T>(func: promiseFunc<T>, time = 1000) {
        return new Promise((resolve, reject) => {
                setTimeout(() => {
                        func(resolve, reject).catch((e: unknown) => {
                                console.error('Error in wrapPromise:', e);
                        });
                }, time);
        });
}

/**
 * Convert markdown to html that Telegram can parse
 * @param s - the string containing markdown
 * @returns HTML formatted string compatible with Telegram
 */
async function markdownToHtml(s: string): Promise<string> {
        marked.setOptions(marked.getDefaults());
        const parsed = await marked.parse(s) as string | { toString(): string };
        const parsedString = typeof parsed === 'string' ? parsed : parsed.toString();
        const tagsToRemove = ['p', 'ol', 'ul', 'li', 'h1', 'h2', 'h3'];
        const tagPattern = new RegExp(tagsToRemove.map((tag) => `<${tag}>|</${tag}>`).join('|'), 'g');
        return parsedString.replace(tagPattern, '');
}

// Constants for system prompts
const SYSTEM_PROMPTS = {
        TUX_ROBOT: 'You are a friendly assistant named TuxRobot. Use lots of emojis in your responses.',
        SEAN: 'You are a friendly person named Sean. Sometimes just acknowledge messages with okay. You are working on coding a cool telegram bot. You are 26 years old and from Toronto, Canada.',
};

// AI model constants
const AI_MODELS = {
        LLAMA: '@cf/meta/llama-3.2-11b-vision-instruct',
        CODER: '@hf/thebloke/deepseek-coder-6.7b-instruct-awq',
        FLUX: '@cf/black-forest-labs/flux-1-schnell',
        STABLE_DIFFUSION: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
} as const;

// 定义AI模型类型
type AiModelKey = keyof typeof AI_MODELS;

// DeepSeek-R1 API configuration
const DEEPSEEK_API = {
        ENDPOINT: 'https://one.lucasmac.asia/v1/chat/completions',
        API_KEY: 'sk-jweX4RYAJwP1JuYX8426FfCdD9Fa4dA8AcE260CcCd074217',
        MAX_CONTEXT: 168000,
        MAX_TOKENS: 32000,
};

// 图片生成API配置
const IMAGE_API = {
        ENDPOINT: 'https://chatgpt4o.lovebabyforever.workers.dev/generate',
};

// D1数据库配置
const DB_CONFIG = {
        MAX_MESSAGES_PER_CHAT: 20,  // 每个聊天最多保存的消息数量
        MAX_MESSAGE_LENGTH: 32000,   // 每条消息最大长度
        CLEANUP_THRESHOLD: 100,     // 触发清理的消息数量阈值
        MESSAGE_EXPIRY_DAYS: 30     // 消息过期天数
};

// Global variable to track if thinking process display is enabled
let showThinkingProcess = false; // 默认不显示思考过程

// Type definitions for API responses
interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface ImageGenerationResponse {
  imageUrl: string;
}

// 定义AI响应类型
interface AiResponse {
  response?: string;
  [key: string]: any;
}

// 定义图片生成响应类型 - 用于Stable Diffusion模型
interface StableDiffusionResponse {
  [key: string]: any;
}

// 定义图片API响应类型
interface ImageApiResponse {
  imageUrl: string;
  [key: string]: any;
}

// 定义文件响应类型
interface FileResponse {
  result: {
    file_path: string;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Call DeepSeek-R1 API with the given messages
 * @param messages - array of message objects
 * @returns response from DeepSeek-R1 API
 */
async function callDeepSeekAPI(messages: any[]) : Promise<DeepSeekResponse> {
        const response = await fetch(DEEPSEEK_API.ENDPOINT, {
                method: 'POST',
                headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${DEEPSEEK_API.API_KEY}`,
                },
                body: JSON.stringify({
                        model: 'deepseek-r1',
                        messages: messages,
                        max_tokens: DEEPSEEK_API.MAX_TOKENS,
                }),
        });

        if (!response.ok) {
                throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
        }

        return await response.json() as DeepSeekResponse;
}

/**
 * 提取思考过程
 * @param content - DeepSeek-R1返回的内容
 * @returns 包含思考过程和最终回复的对象
 */
function extractThinkingProcess(content: string): { thinking: string | null; finalResponse: string } {
        const thinkingRegex = /<think>([\s\S]*?)<\/think>/;
        const match = content.match(thinkingRegex);
        
        if (match && match[1]) {
                // 提取思考过程
                const thinking = match[1].trim();
                // 移除思考过程，获取最终回复
                const finalResponse = content.replace(thinkingRegex, '').trim();
                return { thinking, finalResponse };
        }
        
        // 如果没有思考过程标记，则整个内容作为最终回复
        return { thinking: null, finalResponse: content };
}

/**
 * 清理旧消息以优化D1数据库使用
 * @param db - D1数据库实例
 */
async function cleanupOldMessages(db: D1Database): Promise<void> {
        try {
                // 删除超过过期天数的消息
                const expiryTimestamp = Date.now() - (DB_CONFIG.MESSAGE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
                await db.prepare(`DELETE FROM messages WHERE created_at < ?`).bind(expiryTimestamp).run();
                
                // 获取每个聊天的消息数量
                const chatCountsResult = await db.prepare(`
                        SELECT chat_id, COUNT(*) as message_count 
                        FROM messages 
                        GROUP BY chat_id 
                        HAVING message_count > ?
                `).bind(DB_CONFIG.CLEANUP_THRESHOLD).all();
                
                const chatCounts = chatCountsResult.results as Array<{ chat_id: string; message_count: number }>;
                
                // 对于消息数量超过阈值的聊天，保留最新的MAX_MESSAGES_PER_CHAT条消息
                for (const chat of chatCounts) {
                        // 获取需要保留的消息ID
                        const keepMessagesResult = await db.prepare(`
                                SELECT id FROM messages 
                                WHERE chat_id = ? 
                                ORDER BY created_at DESC 
                                LIMIT ?
                        `).bind(chat.chat_id, DB_CONFIG.MAX_MESSAGES_PER_CHAT).all();
                        
                        const keepMessageIds = keepMessagesResult.results.map((row: any) => row.id);
                        
                        if (keepMessageIds.length > 0) {
                                // 删除不在保留列表中的消息
                                await db.prepare(`
                                        DELETE FROM messages 
                                        WHERE chat_id = ? AND id NOT IN (${keepMessageIds.map(() => '?').join(',')})
                                `).bind(chat.chat_id, ...keepMessageIds).run();
                        }
                }
                
                console.log('Database cleanup completed successfully');
        } catch (error) {
                console.error('Error during database cleanup:', error);
        }
}

/**
 * 保存消息到D1数据库，并限制消息长度
 * @param db - D1数据库实例
 * @param chatId - 聊天ID
 * @param role - 消息角色
 * @param content - 消息内容
 */
async function saveMessage(db: D1Database, chatId: string, role: string, content: string | AiTextGenerationOutput | Ai_Cf_Meta_Llama_3_2_11B_Vision_Instruct_Output): Promise<void> {
        // 将AI输出转换为字符串
        let contentStr: string;
        if (typeof content === 'string') {
                contentStr = content;
        } else if (content && typeof content === 'object' && 'response' in content && content.response) {
                contentStr = content.response;
        } else {
                contentStr = JSON.stringify(content);
        }
        
        // 限制消息长度
        const limitedContent = contentStr.length > DB_CONFIG.MAX_MESSAGE_LENGTH 
                ? contentStr.substring(0, DB_CONFIG.MAX_MESSAGE_LENGTH) 
                : contentStr;
        
        // 保存消息
        await db.prepare(
                `INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)`
        ).bind(chatId, role, limitedContent, Date.now()).run();
}

/**
 * 获取聊天历史
 * @param db - D1数据库实例
 * @param chatId - 聊天ID
 * @returns 聊天历史消息数组
 */
async function getChatHistory(db: D1Database, chatId: string): Promise<Array<{ role: string; content: string }>> {
        const historyResult = await db.prepare(
                `SELECT role, content FROM messages 
                 WHERE chat_id = ? 
                 ORDER BY created_at ASC 
                 LIMIT ?`
        ).bind(chatId, DB_CONFIG.MAX_MESSAGES_PER_CHAT).all();
        
        return historyResult.results as Array<{ role: string; content: string }>;
}

/**
 * 从Stable Diffusion响应中提取图片URL
 * @param response - Stable Diffusion响应
 * @param bot - Telegram执行上下文
 * @returns 图片URL或null
 */
async function extractImageUrlFromStableDiffusion(response: StableDiffusionResponse, bot: TelegramExecutionContext): Promise<string | null> {
    try {
        // 尝试直接使用response作为URL
        if (typeof response === 'string') {
            return response;
        }
        
        // 尝试从response对象中获取URL
        if (response && typeof response === 'object') {
            // 检查是否有data属性
            if ('data' in response && response.data) {
                return response.data as string;
            }
            
            // 检查是否有url属性
            if ('url' in response && response.url) {
                return response.url as string;
            }
            
            // 检查是否有image属性
            if ('image' in response && response.image) {
                return response.image as string;
            }
        }
        
        await bot.reply('图片生成成功，但无法获取图片URL。请稍后再试。', 'HTML');
        return null;
    } catch (error) {
        console.error('Error extracting image URL from Stable Diffusion response:', error);
        return null;
    }
}

/**
 * 将AI输出转换为字符串
 * @param output - AI模型输出
 * @returns 字符串形式的输出
 */
function aiOutputToString(output: string | AiTextGenerationOutput | Ai_Cf_Meta_Llama_3_2_11B_Vision_Instruct_Output): string {
    if (typeof output === 'string') {
        return output;
    } else if (output && typeof output === 'object' && 'response' in output && output.response) {
        return output.response;
    } else {
        return JSON.stringify(output);
    }
}

export default {
        async fetch(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response> {
                try {
                        // 创建单个bot实例
                        const bot = new TelegramBot(env.SECRET_TELEGRAM_API_TOKEN, { defaultCommand: 'message' });
                        
                        // 注册所有命令处理程序
                        bot.on('document', async (bot: TelegramExecutionContext) => {
                                try {
                                        // 获取文件ID
                                        const fileId = bot.update.message?.document?.file_id;
                                        if (!fileId) {
                                                await bot.reply('无法处理文件，请稍后再试。', 'HTML');
                                                return new Response('ok');
                                        }
                                        
                                        const fileResponse = await bot.getFile(fileId) as FileResponse;
                                        
                                        // 构建文件URL
                                        const fileUrl = `https://api.telegram.org/file/bot${bot.bot.token}/${fileResponse.result.file_path}`;
                                        await bot.reply(`文件已接收，您可以通过以下链接访问：${fileUrl}`, 'HTML');
                                } catch (error) {
                                        console.error('Error handling document:', error);
                                        await bot.reply('处理文件时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('epoch', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                await bot.reply(Math.floor(Date.now() / 1000).toString(), 'HTML');
                                        }
                                } catch (error) {
                                        console.error('Error in epoch command:', error);
                                        await bot.reply('处理命令时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('start', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                await bot.reply(
                                                        '初次见面，请多多关照👻',
                                                        'HTML'
                                                );
                                        }
                                } catch (error) {
                                        console.error('Error in start command:', error);
                                        await bot.reply('处理命令时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('dd', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                showThinkingProcess = false;
                                                await bot.reply(`思考过程显示已关闭。`, 'HTML');
                                        }
                                } catch (error) {
                                        console.error('Error in dd command:', error);
                                        await bot.reply('处理命令时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('cc', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                showThinkingProcess = true;
                                                await bot.reply(`思考过程显示已开启。`, 'HTML');
                                        }
                                } catch (error) {
                                        console.error('Error in cc command:', error);
                                        await bot.reply('处理命令时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('clear', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                // 获取聊天ID
                                                const chatId = bot.update.message.chat.id.toString();
                                                
                                                // 删除该聊天的所有历史记录
                                                await env.DB.prepare(`DELETE FROM messages WHERE chat_id = ?`).bind(chatId).run();
                                                
                                                await bot.reply(`聊天历史已清除。`, 'HTML');
                                        }
                                } catch (error) {
                                        console.error('Error in clear command:', error);
                                        await bot.reply('清除历史记录时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('code', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                // 获取提示词
                                                const prompt = bot.update.message.text.replace('/code', '').trim();
                                                
                                                if (!prompt) {
                                                        await bot.reply('请提供代码生成描述，例如：/code 一个简单的Python爬虫', 'HTML');
                                                        return new Response('ok');
                                                }
                                                
                                                // 发送"深度思考中......"消息
                                                await bot.reply('深度思考中......', 'HTML');
                                                
                                                // 获取聊天ID
                                                const chatId = bot.update.message.chat.id.toString();
                                                
                                                // 使用DeepSeek Coder模型生成代码
                                                const response = await env.AI.run(AI_MODELS.CODER, {
                                                        messages: [
                                                            { role: 'system', content: 'You are a coding assistant that MUST ONLY return code. No explanations, no comments outside the code, no introductions, no conclusions. The response should ONLY contain a code block and nothing else. Do not add any text before or after the code block.' },
                                                            { role: 'user', content: 'DO NOT add any explanations. ONLY provide code. ' + prompt }
                                                        ],
                                                }) as AiTextGenerationOutput;
                                                
                                                // 保存用户消息和AI响应到数据库
                                                await saveMessage(env.DB, chatId, 'user', prompt);
                                                await saveMessage(env.DB, chatId, 'assistant', response);
                                                
                                                // 提取代码块
                                                let codeResponse = aiOutputToString(response);
                                                // 如果响应中没有代码块标记，添加代码块标记
                                                if (!codeResponse.includes('```')) {
                                                    // 尝试猜测语言
                                                    let language = '';
                                                    if (prompt.toLowerCase().includes('python')) {
                                                        language = 'python';
                                                    } else if (prompt.toLowerCase().includes('javascript') || prompt.toLowerCase().includes('js')) {
                                                        language = 'javascript';
                                                    } else if (prompt.toLowerCase().includes('java')) {
                                                        language = 'java';
                                                    } else if (prompt.toLowerCase().includes('c++') || prompt.toLowerCase().includes('cpp')) {
                                                        language = 'cpp';
                                                    } else if (prompt.toLowerCase().includes('c#') || prompt.toLowerCase().includes('csharp')) {
                                                        language = 'csharp';
                                                    }
                                                    
                                                    codeResponse = '```' + language + '\n' + codeResponse + '\n```';
                                                }
                                                
                                                // 发送代码响应给用户
                                                await bot.reply(codeResponse, 'Markdown');
                                        }
                                } catch (error) {
                                        console.error('Error in code command:', error);
                                        await bot.reply('代码生成时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('p', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                // 获取提示词
                                                const prompt = bot.update.message.text.replace('/p', '').trim();
                                                
                                                if (!prompt) {
                                                        await bot.reply('请提供图片描述，例如：/p 小猫', 'HTML');
                                                        return new Response('ok');
                                                }
                                                
                                                // 发送"生成图片中......"消息
                                                await bot.reply('生成图片中......', 'HTML');
                                                
                                                // 使用新的图片生成API
                                                try {
                                                        console.log(`Generating image with prompt: ${prompt}`);
                                                        const response = await fetch(IMAGE_API.ENDPOINT, {
                                                                method: 'POST',
                                                                headers: {
                                                                        'Content-Type': 'application/json',
                                                                },
                                                                body: JSON.stringify({
                                                                        prompt: prompt,
                                                                        artStyle: "Ultra Realistic",
                                                                        ratio: "16:9"
                                                                }),
                                                        });
                                                        
                                                        if (!response.ok) {
                                                                throw new Error(`Image API error: ${response.status} ${response.statusText}`);
                                                        }
                                                        
                                                        // 直接获取纯文本URL响应
                                                        const imageUrl = await response.text();
                                                        console.log('Image API response (text URL):', imageUrl);
                                                        
                                                        // 检查是否是有效的URL
                                                        if (imageUrl && imageUrl.trim().startsWith('http')) {
                                                                // 直接发送图片URL给用户
                                                                try {
                                                                        await bot.replyPhoto(imageUrl.trim());
                                                                } catch (photoError) {
                                                                        console.error('Error sending photo:', photoError);
                                                                        // 如果发送图片失败，发送链接
                                                                        await bot.reply(`图片生成成功，但无法直接显示。图片链接：${imageUrl.trim()}`, 'HTML');
                                                                }
                                                        } else {
                                                                throw new Error('No valid image URL in response');
                                                        }
                                                } catch (error) {
                                                        console.error('Error using new image API:', error);
                                                        
                                                        // 如果新API失败，回退到使用Stable Diffusion
                                                        try {
                                                                console.log('Falling back to Stable Diffusion');
                                                                const response = await env.AI.run(AI_MODELS.STABLE_DIFFUSION, { prompt });
                                                                const imageUrl = await extractImageUrlFromStableDiffusion(response, bot);
                                                                
                                                                if (imageUrl) {
                                                                        await bot.replyPhoto(imageUrl);
                                                                }
                                                        } catch (sdError) {
                                                                console.error('Error using Stable Diffusion:', sdError);
                                                                await bot.reply('无法生成图片，请稍后再试。', 'HTML');
                                                        }
                                                }
                                        }
                                } catch (error) {
                                        console.error('Error in p command:', error);
                                        await bot.reply('图片生成时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        })
                        .on('message', async (bot: TelegramExecutionContext) => {
                                try {
                                        if (bot.update.message?.text) {
                                                // 获取用户消息
                                                const userMessage = bot.update.message.text;
                                                
                                                // 获取聊天ID
                                                const chatId = bot.update.message.chat.id.toString();
                                                
                                                // 发送"深度思考中......"消息
                                                await bot.reply('深度思考中......', 'HTML');
                                                
                                                // 获取聊天历史
                                                const history = await getChatHistory(env.DB, chatId);
                                                
                                                // 构建消息数组
                                                const messages = [
                                                        { role: 'system', content: 'You are a helpful assistant. When thinking through a problem, wrap your thinking process in <think></think> tags.' },
                                                        ...history,
                                                        { role: 'user', content: userMessage }
                                                ];
                                                
                                                // 尝试使用DeepSeek-R1 API
                                                try {
                                                        const deepseekResponse = await callDeepSeekAPI(messages);
                                                        const content = deepseekResponse.choices[0].message.content;
                                                        
                                                        // 提取思考过程和最终回复
                                                        const { thinking, finalResponse } = extractThinkingProcess(content);
                                                        
                                                        // 保存用户消息和AI响应到数据库
                                                        await saveMessage(env.DB, chatId, 'user', userMessage);
                                                        await saveMessage(env.DB, chatId, 'assistant', content);
                                                        
                                                        // 根据设置决定是否显示思考过程
                                                        if (showThinkingProcess && thinking) {
                                                                // 发送思考过程
                                                                await bot.reply('```\n' + thinking + '\n```', 'Markdown');
                                                        }
                                                        
                                                        // 发送最终回复
                                                        await bot.reply(finalResponse, 'Markdown');
                                                        
                                                } catch (deepseekError) {
                                                        console.error('Error using DeepSeek-R1 API:', deepseekError);
                                                        
                                                        // 如果DeepSeek-R1 API失败，回退到使用LLAMA模型
                                                        try {
                                                                console.log('Falling back to LLAMA model');
                                                                const llamaResponse = await env.AI.run(AI_MODELS.LLAMA, { messages }) as Ai_Cf_Meta_Llama_3_2_11B_Vision_Instruct_Output;
                                                                
                                                                // 保存用户消息和AI响应到数据库
                                                                await saveMessage(env.DB, chatId, 'user', userMessage);
                                                                await saveMessage(env.DB, chatId, 'assistant', llamaResponse);
                                                                
                                                                // 发送LLAMA响应
                                                                await bot.reply(aiOutputToString(llamaResponse), 'Markdown');
                                                                
                                                        } catch (llamaError) {
                                                                console.error('Error using LLAMA model:', llamaError);
                                                                await bot.reply('抱歉，我暂时无法回答您的问题，请稍后再试。', 'HTML');
                                                        }
                                                }
                                                
                                                // 定期清理旧消息
                                                ctx.waitUntil(cleanupOldMessages(env.DB));
                                        }
                                } catch (error) {
                                        console.error('Error in message handler:', error);
                                        await bot.reply('处理消息时出错，请稍后再试。', 'HTML');
                                }
                                return new Response('ok');
                        });
                        
                        // 处理webhook请求
                        return await bot.handle(request);
                        
                } catch (error) {
                        console.error('Error in fetch handler:', error);
                        return new Response('Error processing request', { status: 500 });
                }
        },
};
