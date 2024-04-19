import { CHAIN, isTelegramUrl, toUserFriendlyAddress, UserRejectsError } from '@tonconnect/sdk';
import { bot } from './bot';
import { getWallets, getWalletInfo } from './ton-connect/wallets';
import QRCode from 'qrcode';
import TelegramBot, { CallbackQuery, InlineKeyboardButton } from 'node-telegram-bot-api';
import { getConnector } from './ton-connect/connector';
import {
    addTGReturnStrategy,
    buildUniversalKeyboard,
    fetchDataGet,
    pTimeout,
    pTimeoutException,
    replyMessage
} from './utils';
import {
    addNewWalletToUser,
    addOrderingDataToUser,
    createUser,
    getPools,
    getPoolWithCaption,
    getUserByTelegramID,
    OrderingData,
    updateUserMode,
    updateUserState,
    updateWallet,
    UserModel
} from './ton-connect/mongo';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient4, WalletContractV4 } from 'ton';
import mongoose from 'mongoose';
import { Jetton, walletAsset } from './dedust/api';

let newConnectRequestListenersMap = new Map<number, () => void>();
const tonClient = new TonClient4({ endpoint: 'https://mainnet-v4.tonhubapi.com' });

export const commandCallback = {
    tradingCallback: handleTradingCallback,
    addNewOrder: handleAddNewOrder,
    addNewWallet: handleAddNewWallet,
    walletSelect: handleWalletSelect,
    selectPair: handleSelectPair
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function handleSelectPair(query: CallbackQuery, _: string) {
    await updateUserMode(query.message?.chat!.id!, _);
    let user = await getUserByTelegramID(query.message?.chat!.id!);
    user!.state.state = 'trading';
    if (user!.mode !== 'swap')
        await replyMessage(query.message!, `🏃 Trading\n\nDo you want to buy/sell?`, [
            [
                {
                    text: '🟢Buy',
                    callback_data: JSON.stringify({ method: 'tradingCallback', data: 'true' })
                },
                {
                    text: '🔴Sell',
                    callback_data: JSON.stringify({ method: 'tradingCallback', data: 'false' })
                }
            ],
            [{ text: '<< Back', callback_data: 'symbol-selectdex' }]
        ]);
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function handleAddNewOrder(query: CallbackQuery) {
    console.log(query);
    const user = await getUserByTelegramID(query.message?.chat!.id!);
    let newOrder = {
        _id: new mongoose.Types.ObjectId(),
        amount: user?.state.amount!,
        jettons: user?.state.jettons!,
        mainCoin: user?.state.mainCoin!,
        isBuy: user?.state.isBuy!,
        price: user?.state.price!,
        state: '',
        dex: user?.mode!
    };
    //check balance
    let mainId = 0,
        flag = false;
    const pool = await getPoolWithCaption(user?.state.jettons!, user!.mode);
    const walletBalance: walletAsset[] = await fetchDataGet(
        `/accounts/${user?.walletAddress}/assets`,
        'dedust'
    );

    if (user?.state.isBuy) {
        //if buy the token is TON
        if (walletBalance[0]?.balance! >= user?.state.amount * 10 ** 9) {
            await addOrderingDataToUser(query.message?.chat!.id!, newOrder);
            //const priceStr = getPriceStr(user.state.jettons,user.state.mainCoin, user!.mode);
            //newOrder.amount *= user.state.isBuy ? user.state.price : 1/user.state.price
            bot.sendMessage(query.message!.chat.id, `New Order is Succesfuly booked, Press /start`);
        } else
            bot.sendMessage(
                query.message!.chat.id,
                `New Order is failed due to invalid balance, Press /start`
            );
    } else {
        //if sell the token is specified one
        walletBalance.forEach(async walletasset => {
            if (user?.state.isBuy) mainId = user?.state.mainCoin;
            else mainId = 1 - user?.state.mainCoin!;
            const assets: Jetton[] = await fetchDataGet('/assets', 'ston');
            const is_ca = user!.state.jettons[mainId]!.length < 10;
            if (is_ca)
                //dedust listed tokens
                assets.forEach(async asset => {
                    //find wallet asset's symbol => asset.symbol
                    if (asset.address === walletasset.asset.address && !flag) {
                        //check if the symbol's balance is available
                        if (asset.symbol === user?.state.jettons[mainId] && !flag) {
                            console.log('########## True ###########\n', asset.symbol);
                            flag = true;
                            if (walletasset.balance < user.state.amount * 10 ** Number(asset.decimals) ) {
                                bot.sendMessage(
                                    query.message!.chat.id,
                                    `Your ${user?.state.jettons[mainId]} balance is not enough!  Press /start`
                                );
                            } else {
                                await addOrderingDataToUser(query.message?.chat!.id!, newOrder);
                                bot.sendMessage(
                                    query.message!.chat.id,
                                    `New Order is Succesfuly booked, Press /start`
                                );
                            }
                            return;
                        }
                    }
                });
            else {
                //dedust unlisted tokens
                if (walletasset.asset.address === user?.state.jettons[mainId]) {
                    let metadata = await fetchDataGet(
                        `/jettons/${walletasset.asset.address}/metadata`,
                        'dedust'
                    );
                    console.log(metadata, 10 ** Number(metadata.decimals) * user.state.amount! <= walletasset.balance)
                    if (
                        10 ** Number(metadata.decimals) * user.state.amount! <=
                        walletasset.balance
                    ) {
                        await addOrderingDataToUser(query.message?.chat!.id!, newOrder);
                        bot.sendMessage(
                            query.message!.chat.id,
                            `New Order is Succesfuly booked, Press /start`
                        );
                        flag = true;
                    }

                }
            }
            if (flag) return;
        });
    }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function handleOrderCommand(msg: TelegramBot.Message){
    let user = await getUserByTelegramID(msg?.chat!.id!);
    let state = user?.state;
    state!.state = 'waitfororder';
    updateUserState(msg?.chat!.id!, state!);
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function handleTradingCallback(query: CallbackQuery, _: string) {
    try {
        //update user state string

        let user = await getUserByTelegramID(query.message?.chat!.id!);
        user!.state.state = 'selectPair';
        // eslint-disable-next-line eqeqeq
        user!.state.isBuy = _ == 'true';
        console.log('trading', _);
        updateUserState(query.message?.chat!.id!, user!.state);
        //fetch assets from dedust API

        // let keyboardArray: InlineKeyboardButton[][] = []; // Type annotation for keyboardArray
        // const filteredAssets = pools!.filter(pool => pool !== undefined);
        // filteredAssets.map((pool, index) => {
        //     if (!!!keyboardArray[Math.floor(index / 4)]) keyboardArray[Math.floor(index / 4)] = [];
        //     const caption = pool.caption[0]! + '/' + pool.caption[1]!;
        //     keyboardArray[Math.floor(index / 4)]![index % 4] = {text: caption, callback_data: `symbol-${caption}`};
        // });
        // keyboardArray.push([{text:'<< Back', callback_data: 'newStart'}]);
        let text = `🏃 Trading\n\n💡Please type in correct Jetton's Symbol/Name/address\nType in CA for new published tokens.\n\nFor example:\n🔸"jUSDT" NOT "jusdt" or "JUSDT"\n🔸"Ton Bridge USD"\n🔸"EQBynBO23yw ... STQgGoXwiuA"`;
        await bot
            .editMessageCaption(text, {
                message_id: query.message?.message_id,
                chat_id: query.message?.chat.id
            })
            .then(() => {})
            .catch(async () => {
                await bot.editMessageText(text, {
                    message_id: query.message?.message_id,
                    chat_id: query.message?.chat.id,
                    parse_mode: 'HTML'
                });
            });
        await bot.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: '<< Back', callback_data: 'symbol-selectdex' }]] },
            {
                message_id: query.message?.message_id,
                chat_id: query.message?.chat.id
            }
        );
    } catch (error) {
        console.log(error);
    }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function handleOrderingBookCommand(query: CallbackQuery){
    let user = await getUserByTelegramID(query.message!.chat.id);
    let orderingBtns: InlineKeyboardButton[][] = [];
    user?.orderingData?.map((order, index) => {
        if (orderingBtns[index]) orderingBtns[index] = [];
        orderingBtns[index] = [
            {
                text: order.isBuy
                    ? 'Buy ' +
                      order.jettons[1 - order.mainCoin] +
                      ' from ' +
                      order.amount +
                      ' ' +
                      order.jettons[order.mainCoin] +
                      ' at 1' +
                      order.jettons[1 - order.mainCoin] +
                      '=' +
                      order.price +
                      ' ' +
                      order.jettons[order.mainCoin]
                    : 'Sell ' +
                      order.amount +
                      ' ' +
                      order.jettons[1 - order.mainCoin] +
                      ' at 1 ' +
                      order.jettons[1 - order.mainCoin] +
                      '=' +
                      order.price +
                      ' ' +
                      order.jettons[order.mainCoin],
                callback_data: 'orderclick-' + order._id.toHexString()
            }
        ];
    })
    orderingBtns.push([{ text: '<< Back', callback_data: 'symbol-selectdex' }]);
    let state: OrderingData = user?.state!;
    state!.state = 'ordermanage';
    updateUserState(query.message?.chat.id!, state);
    replyMessage(query.message!, `📕 Ordering Book\n\nClick order button to delete`, orderingBtns);
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function handleStartCommand(msg: TelegramBot.Message) {
    //update / create user info
    const userId = msg.chat!.id;
    console.log(userId);
    let prevUser = await getUserByTelegramID(userId);
    let telegramWalletAddress;

    if (prevUser) {
        //set userstate idle
        await updateUserState(userId,{
            _id: new mongoose.Types.ObjectId(),
            state: 'idle',
            jettons: ['', ''],
            mainCoin: 0,
            amount: 0,
            price: 0,
            isBuy: false,
            dex: '',
        });
    } else {
        let mnemonics = await mnemonicNew();
        let keyPair = await mnemonicToPrivateKey(mnemonics);
        // Create wallet contract
        // Usually you need a workchain 0
        const wallet = tonClient.open(
            WalletContractV4.create({
                workchain: 0,
                publicKey: keyPair!.publicKey
            })
        );
        const address = wallet.address;
        let newUser = await UserModel.create({
            telegramID: msg.chat!.id,
            walletAddress: address.toString(),
            secretKey: mnemonics.join(','),
            wallets: [mnemonics.join(',')],
            mode: '',
            state: {
                state: 'idle',
                jettons: ['', ''],
                mainCoin: 0,
                amount: 0,
                price: 0,
                isBuy: false,
                dex: ''
            }
        });
        await createUser(newUser);
        //save in variable to show
        // eslint-disable-next-line unused-imports/no-unused-vars
        telegramWalletAddress = address.toString();
    }
    await bot.sendPhoto(msg.chat.id, './imgpsh_fullsize_anim.png', {
        caption: `
*What can Reward.tg TraderBot do for you :*

- Create multi TON wallet address
- Do instant swap
- Set trade order
- Get info about all TON token
- Get Alerts
- And more ... 

Type /start to start your *Reward.tg* bot !  `,
        reply_markup:{
            inline_keyboard:[
                [{ text: '💵 My wallet', callback_data: 'showMyWallet' }],
                [
                    { text: '♻️ Instant Swap', callback_data: 'instanteSwap' },
                    {
                        text: '🏃 Book Order',
                        /*web_app:{url:'https://web.ton-rocket.com/trade'}*/ callback_data:
                            'symbol-selectdex'
                    }
                ],
                [{ text: '🏆 Exclusif:Earn Reward from TON Token', callback_data: 'exclusif' }],
                [
                    { text: '💡 Token Info ( soon )', callback_data: 'instanap' },
                    {
                        text: '🚨 Alert ( soon )',
                        /*web_app:{url:'https://web.ton-rocket.com/trade'}*/ callback_data:
                            'sselectdex'
                    }
                ],
                [{ text: '🔨 Tools and Settings', callback_data: 'setting' }],
                [{ text: '🥇 Premium ( soon )', callback_data: 'seng' }]
                //[{text:'🔗 Connect Your Wallet',callback_data:'walletConnect'},{text:'✂ Disconnect Wallet', callback_data:'disConnect'}],
                //[{text:'📤 Deposit', callback_data:'deposit'},{text:'📥 Withdraw', callback_data:'withdraw'}],
            ]
        },
        parse_mode: 'Markdown'
    });
}

export async function handleAddNewWallet(query: CallbackQuery): Promise<void> {
    let mnemonics = await mnemonicNew();
    await addNewWalletToUser(query.message?.chat.id!, mnemonics.join(','));
    await handleShowMyWalletCommand(query.message!);
}

export async function handleWalletSelect(query: CallbackQuery, _: string): Promise<void> {
    const user = await getUserByTelegramID(query.message?.chat.id!);
    let mnemonic = user!.wallets[Number(_)]!.split(',')
    let keyPair = await mnemonicToPrivateKey(mnemonic);

    const wallet = tonClient.open(
        WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair!.publicKey
        })
    );
    console.log(mnemonic);
    console.log(wallet.address.toString());
    await updateWallet( query.message?.chat.id!,
        wallet.address.toString(),
        user!.wallets[Number(_)]!
    );
    await handleShowMyWalletCommand(query.message!)
}
export async function handleExclusifCommand(query: CallbackQuery): Promise<void> {
    bot.sendMessage(
        query.message?.chat.id!,
        'Joins now https://reward.tg and earn each day exclusif reward from all TON token on TON chain.'
    );
}
export async function handleConnectCommand(msg: TelegramBot.Message): Promise<void> {
    console.log('connect!!');
    const chatId = msg.chat.id;
    let messageWasDeleted = false;

    newConnectRequestListenersMap.get(chatId)?.();

    const connector = getConnector(chatId, () => {
 //       unsubscribe();
//        newConnectRequestListenersMap.delete(chatId);
//        deleteMessage();
    });

    await connector.restoreConnection();
    if (connector.connected) {
        const connectedName =
            (await getWalletInfo(connector.wallet!.device.appName))?.name ||
            connector.wallet!.device.appName;
        await bot.sendMessage(
            chatId,
            `🔗 Connect Wallet\n\n💡You have already connect ${connectedName} wallet\nYour address: ${toUserFriendlyAddress(
                connector.wallet!.account.address,
                connector.wallet!.account.chain === CHAIN.MAINNET
            )}\n\n Disconnect wallet firstly to connect a new one`,{
                reply_markup: {
                    inline_keyboard: [
                        [{text:'<< Back', callback_data: 'newStart'}]
                    ]
                }
            }
        );

        return;
    }

    const unsubscribe = connector.onStatusChange(async wallet => {
        if (wallet) {
            await deleteMessage();

            const walletName =
                (await getWalletInfo(wallet.device.appName))?.name || wallet.device.appName;
            await bot.sendPhoto(chatId, `🔗 Connect Wallet\n\n${walletName} wallet connected successfully`,{
                reply_markup: {
                    inline_keyboard: [
                        [{text:'<< Back', callback_data: 'newStart'}]
                    ]
                }
            });
            unsubscribe();
            newConnectRequestListenersMap.delete(chatId);
        }
    });
    const wallets = await getWallets();

    const link = connector.connect(wallets);
    const image = await QRCode.toBuffer(link);

    const keyboard = await buildUniversalKeyboard(link, wallets);

    const botMessage = await bot.sendPhoto(chatId, image, {
        reply_markup: {
            inline_keyboard: [
                keyboard,
                [{text:'<< Back', callback_data: 'newStart'}]
            ]
        }
    });

    const deleteMessage = async (): Promise<void> => {
        if (!messageWasDeleted) {
            messageWasDeleted = true;
            await bot.deleteMessage(chatId, botMessage.message_id);
        }
    };

    newConnectRequestListenersMap.set(chatId, async () => {
        unsubscribe();

        await deleteMessage();

        newConnectRequestListenersMap.delete(chatId);
    });
}
export async function handleSettingCommand(query: CallbackQuery): Promise<void> {
    replyMessage(query.message!,`🔨 Tools and Settings\n\n
    Please <b>Connect Wallet</b> to <b>Deposit</b> and <b>Start Trading</b>.`,
    [
        [{text:'🔗 Connect Your Wallet',callback_data:'walletConnect'},{text:'✂ Disconnect Wallet', callback_data:'disConnect'}],
        [{text:'📤 Deposit', callback_data:'deposit'},{text:'📥 Withdraw', callback_data:'withdraw'}],
        [{text:'🛟 Backup', callback_data:'backup'}],
        [{text:'<< Back', callback_data:'newStart' }]
    ])
}
export async function handleBackupCommand(query: CallbackQuery): Promise<void> {
    const user = await getUserByTelegramID(query.message?.chat!.id!);
    replyMessage(query.message!,`🔨 Tools and Settings\n\n${user?.secretKey}`,
    [
        [{text:'<< Back', callback_data:'setting' }]
    ])
}
export async function handleSendTXCommand(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const connector = getConnector(chatId);

    await connector.restoreConnection();
    if (!connector.connected) {
        await bot.sendMessage(chatId, '💡Connect wallet to deposit');
        return;
    }

    pTimeout(
        connector.sendTransaction({
            validUntil: Math.round(
                (Date.now() + Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)) / 1000
            ),
            messages: [
                { 
                    amount: '1000000',
                    address: '0:0000000000000000000000000000000000000000000000000000000000000000'
                }
            ]
        }),
        Number(process.env.DELETE_SEND_TX_MESSAGE_TIMEOUT_MS)
    )
        .then(() => {
            bot.sendMessage(chatId, `💡Transaction sent successfully`);
        })
        .catch(e => {
            if (e === pTimeoutException) {
                bot.sendMessage(chatId, `💡Transaction was not confirmed`);
                return;
            }

            if (e instanceof UserRejectsError) {
                bot.sendMessage(chatId, `💡You rejected the transaction`);
                return;
            }

            bot.sendMessage(chatId, `💡Unknown error happened`);
        })
        .finally(() => connector.pauseConnection());

    let deeplink = '';
    const walletInfo = await getWalletInfo(connector.wallet!.device.appName);
    if (walletInfo) {
        deeplink = walletInfo.universalLink;
    }

    if (isTelegramUrl(deeplink)) {
        const url = new URL(deeplink);
        url.searchParams.append('startattach', 'tonconnect');
        deeplink = addTGReturnStrategy(url.toString(), process.env.TELEGRAM_BOT_LINK!);
    }

    await bot.sendMessage(
        chatId,
        `Open ${walletInfo?.name || connector.wallet!.device.appName} and confirm transaction`,
        {
            reply_markup: {
                inline_keyboard: [[{
                    text: `Open ${walletInfo?.name || connector.wallet!.device.appName}`,
                    url: deeplink
                }]]
            }
        }
    );
}

export async function handleDisconnectCommand(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const connector = getConnector(chatId);

    await connector.restoreConnection();
    if (!connector.connected) {
        await bot.sendMessage(chatId, "✂ Disconnect Wallet\n\n💡You didn't connect a wallet",{
            reply_markup: {
                inline_keyboard: [
                    [{text:'<< Back', callback_data: 'newStart'}]
                ]
            }
        });
        return;
    }

    await connector.disconnect();

    await bot.sendMessage(chatId, '✂ Disconnect Wallet\n\n💡Wallet has been disconnected',{
        reply_markup: {
            inline_keyboard: [
                [{text:'<< Back', callback_data: 'newStart'}]
            ]
        }
    });
}

export async function handleDepositCommand(query: CallbackQuery){
    const user = await getUserByTelegramID(query.message?.chat!.id!);

    replyMessage(query.message!, `📤 Deposit\n\n💡Your RewardBot Wallet Address is \n<code>${user?.walletAddress}</code>`,[[{text:'<< Back', callback_data: 'newStart'}]])
}

export async function handleWithdrawCommand(query: CallbackQuery){
    
    const user = await getUserByTelegramID(query.message!.chat!.id);

    const address = user?.walletAddress;
    console.log(user);
    const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
    const assets: Jetton[] = await fetchDataGet('/assets', user!.mode);
    let outputStr = 'Toncoin : ' + (balances[0]?.balance ? (Number(balances[0]?.balance) / 1000000000) : '0') + ' TON\n';
    let buttons: InlineKeyboardButton[][] = [[{text:'TON', callback_data:'symbol-with-TON'}]];
    let counter = 0;
    balances.map((walletAssetItem) => {
    
        const filteredAssets = assets.map((asset) => {
            if(walletAssetItem.asset.type != 'native')
                if(asset.address === walletAssetItem.asset.address){
                    counter ++;
                    outputStr += asset.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset.decimals) + ' ' + asset.symbol + '\n';
                    if(buttons[Math.floor(counter/3)] == undefined)
                        buttons[Math.floor(counter/3)] = []
                    buttons[Math.floor(counter/3)]![counter % 3] = {text:asset.symbol, callback_data: 'symbol-with-' + asset.symbol}
                }
        });
    });
    console.log(buttons)
    buttons.push([{text:'<< Back', callback_data: 'newStart'}]);
    bot.sendMessage(
        query.message!.chat.id,
        `📤 Withdraw\n\n💡Please click the coin's button to withdraw\nYou shuld have enough TON on this wallet to withdraw\n\n${outputStr}`,
        { reply_markup:{ inline_keyboard:buttons }, parse_mode:'HTML' }
    );
}

export async function handleShowMyWalletCommand(msg: TelegramBot.Message): Promise<void> {
    // const chatId = msg.chat.id;

    // const connector = getConnector(chatId);

    // await connector.restoreConnection();
    // if (!connector.connected) {
    //     await bot.sendMessage(chatId, "You didn't connect a wallet");
    //     return;
    // }

    // const walletName =
    //     (await getWalletInfo(connector.wallet!.device.appName))?.name ||
    //     connector.wallet!.device.appName;
    // const address = toUserFriendlyAddress(
    //     connector.wallet!.account.address,
    //     connector.wallet!.account.chain === CHAIN.MAINNET,
    // )
    console.log(msg);

    const user = await getUserByTelegramID(msg.chat!.id);

    const address = user?.walletAddress;
    const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
    const assets: Jetton[] = await fetchDataGet('/assets', 'ston');
    console.log(balances);
    let outputStr = '\nToncoin : ' + (balances[0]?.balance ? (Number(balances[0]?.balance) / 1000000000) : '0') + ' TON\n\n<b>-ALT TOKEN</b>\n';

    balances.map((walletAssetItem) => {
    
        assets.map((asset) => {
            if(walletAssetItem.asset.type != 'native')
                if(asset.address === walletAssetItem.asset.address){
                    outputStr += asset.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset.decimals) + ' ' + asset.symbol + '\n';
                }
        });
    });
    let currentIndex = 0;
    let walletBtns: InlineKeyboardButton[][] = [[{text: "Add New Wallet", callback_data: JSON.stringify({method:"addNewWallet"})}]];
    user?.wallets.map((secret, index) => {
        let emoji = '';
        if(secret == user.secretKey) {
            console.log(index)
        currentIndex = index;
        emoji = '⭐';
    }
        if(!walletBtns[index + 1]) walletBtns[Math.floor((index + 1))] = [];
        let temp = secret;
        walletBtns[index + 1] = [{text:emoji + "Wallet " + index + emoji, callback_data:JSON.stringify({method:'walletSelect',data:index})}]
    })
    walletBtns.push([{text:'<< Back', callback_data: 'newStart'}])
    replyMessage(msg,
        `💵 My wallet ${currentIndex}\n\nYour RewardBot Wallet address:\n <code>${address}</code>\n ${outputStr}`,
        walletBtns
    )
}

export async function handleInstanteSwap(query: CallbackQuery): Promise<void> {
    try{
        let user = await getUserByTelegramID(query.message!.chat.id);
        user!.state.state = 'trading';
        updateUserMode(query.message?.chat.id!,"swap");
        updateUserState(query.message?.chat!.id!, user!.state);

        //fetch assets from dedust API
        const pools = await getPools();
        const rows = Math.ceil(pools!.length / 4);

        // let keyboardArray: InlineKeyboardButton[][] = []; // Type annotation for keyboardArray
        // const filteredAssets = pools!.filter(pool => pool !== undefined);
        // filteredAssets.map((pool, index) => {
        //     if (!!!keyboardArray[Math.floor(index / 4)]) keyboardArray[Math.floor(index / 4)] = [];
        //     const caption = pool.caption[0]! + '/' + pool.caption[1]!;
        //     keyboardArray[Math.floor(index / 4)]![index % 4] = {text: caption, callback_data: `symbol-${caption}`};
        // });
        // keyboardArray.push([{text:'<< Back', callback_data: 'newStart'}]);
        let text = `♻️ Instant Swap\n\n💡Please type in correct Jetton's Symbol/Name/address\n\nFor example:\n🔸"jUSDT", NOT "jusdt" or "JUSDT"\n🔸"Ton Bridge USD"\n🔸"EQBynBO23yw ... STQgGoXwiuA"`;
        await bot.editMessageCaption(
            text,
            {
                message_id: query.message?.message_id,
                chat_id: query.message?.chat.id
            }
        ).then(() => {})
        .catch(async () => {
            await bot.editMessageText(text, {
                message_id: query.message?.message_id,
                chat_id: query.message?.chat.id,
                parse_mode: 'HTML'
            });
        });
        await bot.editMessageReplyMarkup(
            { inline_keyboard: [[{text:'<< Back', callback_data: 'newStart'}]] },
            {
                message_id: query.message?.message_id,
                chat_id: query.message?.chat.id
            }
        );
            
    } catch (error) {
        console.log(error)
    }
}