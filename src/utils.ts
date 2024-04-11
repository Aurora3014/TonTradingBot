import { encodeTelegramUrlParameters, isTelegramUrl, WalletInfoRemote } from '@tonconnect/sdk';
import { InlineKeyboardButton, Message } from 'node-telegram-bot-api';
import { bot } from './bot';
import { fetchPrice, Jetton } from './dedust/api';
import axios from 'axios';

export const AT_WALLET_APP_NAME = 'telegram-wallet';

export const pTimeoutException = Symbol();

export function pTimeout<T>(
    promise: Promise<T>,
    time: number,
    exception: unknown = pTimeoutException
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise((_r, rej) => (timer = setTimeout(rej, time, exception)))
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export function addTGReturnStrategy(link: string, strategy: string): string {
    const parsed = new URL(link);
    parsed.searchParams.append('ret', strategy);
    link = parsed.toString();

    const lastParam = link.slice(link.lastIndexOf('&') + 1);
    return link.slice(0, link.lastIndexOf('&')) + '-' + encodeTelegramUrlParameters(lastParam);
}

export function convertDeeplinkToUniversalLink(link: string, walletUniversalLink: string): string {
    const search = new URL(link).search;
    const url = new URL(walletUniversalLink);

    if (isTelegramUrl(walletUniversalLink)) {
        const startattach = 'tonconnect-' + encodeTelegramUrlParameters(search.slice(1));
        url.searchParams.append('startattach', startattach);
    } else {
        url.search = search;
    }

    return url.toString();
}
//eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function fetchDataGet(fetchURL: String, dex:String) {
    let initString = '';
    if(dex == 'dedust') initString = 'https://api.dedust.io/v2';
    else if (dex == 'ston') initString = 'https://api.ston.fi/v1';
    else if (dex == '') initString = 'https://api.dedust.io/v2'
    try {
        const response = await axios.get(initString + fetchURL, {
            headers: {
                accept: 'application/json'
            }
        });
        console.log('Fetch Success => ' + fetchURL); // Output the response data
        return response.data;
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}
export async function buildUniversalKeyboard(
    link: string,
    wallets: WalletInfoRemote[]
): Promise<InlineKeyboardButton[]> {
    const atWallet = wallets.find(wallet => wallet.appName.toLowerCase() === AT_WALLET_APP_NAME);
    const atWalletLink = atWallet
        ? addTGReturnStrategy(
              convertDeeplinkToUniversalLink(link, atWallet?.universalLink),
              process.env.TELEGRAM_BOT_LINK!
          )
        : undefined;
    const keyboard = [
        {
            text: 'Choose a Wallet',
            callback_data: JSON.stringify({ method: 'chose_wallet' })
        },
        {
            text: 'Open Link',
            url: `https://ton-connect.github.io/open-tc?connect=${encodeURIComponent(link)}`
        }
    ];

    if (atWalletLink) {
        keyboard.unshift({
            text: '@wallet',
            url: atWalletLink
        });
    }

    return keyboard;
}

export async function replyMessage(msg: Message, text: string, inlineButtons?: InlineKeyboardButton[][]){
    await bot.editMessageText( text,{
        message_id: msg.message_id,
        chat_id: msg.chat.id,
        parse_mode: 'HTML'
    });
    if(inlineButtons != undefined)
        await bot.editMessageReplyMarkup(
            { inline_keyboard: inlineButtons! },
            {
                message_id: msg.message_id,
                chat_id: msg.chat.id
            }
        );
}

export async function getPriceStr(jettons:string[],mainId:number, dex: string){
    let assets: Jetton[] = await fetchDataGet('/assets', dex);
    let addresses = ['',''];
    let decimals = [0,0]
    assets.map((asset) => {
        if(asset.symbol == jettons[0]){
            addresses[0] = asset.type == 'native' ? asset.type : 'jetton:' + asset.address
            decimals[0] = asset.decimals

        }

        if(asset.symbol == jettons[1]){
            addresses[1] = asset.type == 'native' ? asset.type : 'jetton:' + asset.address
            decimals[1] = asset.decimals

        }
    })
    let price: number = await fetchPrice(10 ** decimals[1-mainId]!, addresses[1 - mainId]!, addresses[mainId]!, dex)
    price /= 10 ** decimals[mainId]!;
    
    const strPrice = price.toFixed(Math.log10(price) <0 ? -1 * Math.ceil(Math.log10(price)) + 2 : 0);
    console.log(strPrice, addresses)
    return strPrice;
}
