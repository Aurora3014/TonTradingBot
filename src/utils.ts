import { encodeTelegramUrlParameters, isTelegramUrl, WalletInfoRemote } from '@tonconnect/sdk';
import { InlineKeyboardButton, Message } from 'node-telegram-bot-api';
import { bot } from './bot';
import { fetchPrice, Jetton } from './dedust/api';
import axios from 'axios';
import { getPoolWithCaption, Pool } from './ton-connect/mongo';
import { exit } from 'process';

export const AT_WALLET_APP_NAME = 'telegram-wallet';


interface AssetStonFi {
    balance: string,
    blacklisted: true,
    community: true,
    contract_address: string,
    decimals: 0,
    default_symbol: true,
    deprecated: true,
    dex_price_usd: string,
    dex_usd_price: string,
    display_name: string,
    image_url: string,
    kind: string,
    symbol: string,
    third_party_price_usd: string,
    third_party_usd_price: string,
    wallet_address: string
}

interface PoolStonFi {
    address: string,
    apy_1d: string,
    apy_30d: string,
    apy_7d: string,
    collected_token0_protocol_fee: string,
    collected_token1_protocol_fee: string,
    deprecated: true,
    lp_account_address: string,
    lp_balance: string,
    lp_fee: string,
    lp_price_usd: string,
    lp_total_supply: string,
    lp_total_supply_usd: string,
    lp_wallet_address: string,
    protocol_fee: string,
    protocol_fee_address: string,
    ref_fee: string,
    reserve0: string,
    reserve1: string,
    router_address: string,
    token0_address: string,
    token0_balance: string,
    token1_address: string,
    token1_balance: string
}


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
export async function fetchDataGet(fetchURL: String, dex:String):Promise <any> {
    let initString = '';
    if(dex == 'dedust') initString = 'https://api.dedust.io/v2';
    else if (dex == 'ston') initString = 'https://api.ston.fi/v1';
    else initString = 'https://api.dedust.io/v2'
    try {
        const response = await axios.get(initString + fetchURL, {
            headers: {
                accept: 'application/json'
            }
        });
        console.log('Fetch Success => ' + fetchURL); // Output the response data
        if(dex == 'ston'){
            if(fetchURL == '/assets'){
                const assetSton: any[] = response.data['asset_list'];
                assetSton.map((assetStonOne) => {
                    assetStonOne.type = assetStonOne.kind;
                    assetStonOne.address = assetStonOne.contract_address;
                    assetStonOne.name = assetStonOne.display_name;
                    assetStonOne.symbol = assetStonOne.symbol;
                    assetStonOne.image = assetStonOne.image_url;
                    assetStonOne.decimals = assetStonOne.decimals;
                    assetStonOne.riskScore = '0';
                })

                return assetSton!;
            }else if(fetchURL == '/pools'){
                const assetSton: any[] = response.data['pool_list'];
                let pools: Pool[];
                assetSton.filter(
                    (singleAsset) => 
                        singleAsset.token0_address == 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' ||
                        singleAsset.token1_address == "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
                )
                
                assetSton.map((assetStonOne) => {
                    assetStonOne.caption = ['',''];
                    assetStonOne.address = assetStonOne.address;
                    assetStonOne.lt = assetStonOne.lp_total_supply;
                    assetStonOne.totalSupply = Number(assetStonOne.lp_total_supply);
                    assetStonOne.type = 'ston';
                    assetStonOne.tradeFee = Number(assetStonOne.lp_fee);
                    assetStonOne.prices = [0,0];
                    assetStonOne.assets = [assetStonOne.token0_address, assetStonOne.token1_address];
                    assetStonOne.reserves = [Number(assetStonOne.reserve0),Number(assetStonOne.reserve1)];
                    assetStonOne.fees = [Number(assetStonOne.reserve0), Number(assetStonOne.reserve1)];
                    assetStonOne.volume = [BigInt(0),BigInt(0)];
                    assetStonOne.decimals = [0,0];
                    assetStonOne.TVL = Number(assetStonOne.lp_total_supply_usd);
                    assetStonOne.main = assetStonOne.token0_address == "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c" ? 0 : 1;
                    assetStonOne.dex = 'ston';
                    assetStonOne.assets = [assetStonOne.token0_address, assetStonOne.token1_address]
                })
                return assetSton!;
            }
        }else return response.data
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
    if(dex == 'ston') {
        const pool = await getPoolWithCaption(jettons,dex);
        addresses = pool?.assets!;
        console.log('decimals', decimals, pool,jettons)

    }
    let price: number = await fetchPrice(10 ** decimals[1-mainId]!, addresses[1 - mainId]!, addresses[mainId]!, dex)
    price /= 10 ** decimals[mainId]!;
    
    const strPrice = price.toFixed(Math.log10(price) <0 ? -1 * Math.ceil(Math.log10(price)) + 2 : 4);
    console.log(strPrice, addresses)
    return strPrice;
}
