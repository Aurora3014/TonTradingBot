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
    getPriceStr,
    pTimeout,
    pTimeoutException,
    replyMessage
} from './utils';
import {
    addNewWalletToUser,
    addOrderingDataToUser,
    createUser,
    deleteOrderingDataFromUser,
    deleteWalletSecret,
    getAltTokenWithAddress,
    getPools,
    getPoolWithCaption,
    getUserByTelegramID,
    OrderingData,
    Pool,
    updateUserMode,
    updateUserState,
    updateWallet,
    User,
    UserModel
} from './ton-connect/mongo';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient4, WalletContractV4 } from 'ton';
import mongoose, { Callback } from 'mongoose';
import { Jetton, walletAsset } from './dedust/api';

let newConnectRequestListenersMap = new Map<number, () => void>();
const tonClient = new TonClient4({ endpoint: 'https://mainnet-v4.tonhubapi.com' });

export const commandCallback = {
    tradingCallback: handleTradingCallback,
    addNewOrder: handleAddNewOrder,
    addNewWallet: handleAddNewWallet,
    walletSelect: handleWalletSelect,
    selectPair: handleSelectPair,
    walletDelete: handleWalletDelete,
    activateWallet:handleWalletActivate,
    deleteWallet:handleWalletDelete,
    addNewWalletConfirm: handleAddNewWalletConfirm,
    transferToken: handleTransferToken,
    deleteOrder: handleDeleteOrderCommand,
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function handleSelectPair(query: CallbackQuery, _: string) {
    //await updateUserMode(query.message?.chat!.id!, _);
    let user = await getUserByTelegramID(query.message?.chat!.id!);
    user!.state.dex = _;
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
    else
        await replyMessage(query.message!, `♻️ Instant Swap\n\nDo you want to buy/sell?`, [
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
            [{ text: '<< Back', callback_data: 'symbol-selectdex-swap' }]
        ]);
    await updateUserState(query.message?.chat.id!,user!.state);
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
        dex: user?.state.dex!,
        walletSecretKey: user?.secretKey!,
        mode: user!.mode
    };
    let word = '';
    if(user!.mode == 'swap')
        word = 'New TX is successfuly sent.';
    else 
        word = 'New Order is Succesfuly booked';
    //check balance
    let mainId = 0,
        flag = false;
    const pool = await getPoolWithCaption(user?.state.jettons!, user!.state.dex);
    const walletBalance: walletAsset[] = await fetchDataGet(
        `/accounts/${user?.walletAddress}/assets`,
        'dedust'
    );

    if (user?.state.isBuy) {
        //if buy the token is TON
        if (walletBalance[0]?.balance! >= user?.state.amount * 10 ** 9) {
            await addOrderingDataToUser(query.message?.chat!.id!, newOrder);
            //const priceStr = getPriceStr(user.state.jettons,user.state.mainCoin, user!.state.state);
            //newOrder.amount *= user.state.isBuy ? user.state.price : 1/user.state.price
            bot.sendMessage(query.message!.chat.id, `${word}, Press /start`);
        } else
            bot.sendMessage(
                query.message!.chat.id,
                `New action is failed due to invalid balance, Press /start`
            );
    } else {
        //if sell the token is specified one
        walletBalance.forEach(async walletasset => {
            if (user?.state.isBuy) mainId = user?.state.mainCoin;
            else mainId = 1 - user?.state.mainCoin!;
            // const assets: Jetton[] = await fetchDataGet('/assets', 'ston');
            const is_ca = user!.state.jettons[mainId]!.length < 10;
            if (is_ca){
                //dedust listed tokens
                let asset = await getAltTokenWithAddress(walletasset.asset.address , user?.state.dex!)
                console.log(user?.state.dex!, asset)
                //find wallet asset's symbol => asset.symbol
                if (!flag && asset != null) {
                    //check if the symbol's balance is available
                    if (asset!.symbol === user?.state.jettons[mainId] && !flag) {
                        console.log('########## True ###########\n', asset!.symbol);
                        flag = true;
                        if (walletasset.balance < user.state.amount * 10 ** Number(asset!.decimals) ) {
                            bot.sendMessage(
                                query.message!.chat.id,
                                `Your ${user?.state.jettons[mainId]} balance is not enough!  Press /start`
                            );
                        } else {
                            await addOrderingDataToUser(query.message?.chat!.id!, newOrder);
                            bot.sendMessage(
                                query.message!.chat.id,
                                `${word}, Press /start`
                            );
                        }
                        return;
                    }
                }
            } else {
                //dedust unlisted tokens
                if (walletasset.asset.address === user?.state.jettons[mainId]) {
                    let metadata = await getAltTokenWithAddress(
                        walletasset.asset.address,
                        'dedust'
                    );
                    console.log(metadata, 10 ** Number(metadata!.decimals) * user.state.amount! <= walletasset.balance)
                    if (
                        10 ** Number(metadata!.decimals) * user.state.amount! <=
                        walletasset.balance
                    ) {
                        await addOrderingDataToUser(query.message?.chat!.id!, newOrder);
                        bot.sendMessage(
                            query.message!.chat.id,
                            `${word}, Press /start`
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
        const address = user?.walletAddress;
        const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
        // const assets: Jetton[] = await fetchDataGet('/assets', user!.state.state);
        let outputStr = 'Toncoin : ' + (balances[0]?.balance ? (Number(balances[0]?.balance) / 1000000000) : '0') + ' TON\n';
        let buttons: InlineKeyboardButton[][] = [[]];
        let counter = 0;
        for(const walletAssetItem of balances){
            if(walletAssetItem.asset.type != 'native'){
                let asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'dedust');
                if(asset == null) 
                    asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'ston');
                if(asset != null){
                    outputStr += asset!.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset!.decimals) + ' ' + asset!.symbol + '\n';
                    if(buttons[Math.floor(counter/3)] == undefined)
                        buttons[Math.floor(counter/3)] = []
                    buttons[Math.floor(counter/3)]![counter % 3] = {text:asset!.symbol, callback_data: 'symbol-sell-' + asset!.address}
                    counter ++;
                }
                };
            }
        
        console.log(buttons)
        // let keyboardArray: InlineKeyboardButton[][] = []; // Type annotation for keyboardArray
        // const filteredAssets = pools!.filter(pool => pool !== undefined);
        // filteredAssets.map((pool, index) => {
        //     if (!!!keyboardArray[Math.floor(index / 4)]) keyboardArray[Math.floor(index / 4)] = [];
        //     const caption = pool.caption[0]! + '/' + pool.caption[1]!;
        //     keyboardArray[Math.floor(index / 4)]![index % 4] = {text: caption, callback_data: `symbol-${caption}`};
        // });
        // keyboardArray.push([{text:'<< Back', callback_data: 'newStart'}]);
        
        let text = '';
        if(user!.mode == 'swap'){
            text = `♻️ Instant Swap`;
            buttons.push([{text:'<< Back', callback_data: 'symbol-selectdex-swap'}]);
        }
        else{
            text = `🏃 Trading`;
            buttons.push([{text:'<< Back', callback_data: 'symbol-selectdex'}]);
        }

        text += `\n\n💡Please type in correct Jetton's Symbol/address\n  Type in CA for new published tokens.\n\nFor example:\n🔸"jUSDT" NOT "jusdt" or "JUSDT"\n🔸"EQBynBO23yw ... STQgGoXwiuA"`;
        
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
            { inline_keyboard: buttons },
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
    if (user && user.orderingData) {
        for (const order of user.orderingData) {
            if (order.jettons[1 - order.mainCoin]!.length >= 10) {
                let metadata = await getAltTokenWithAddress(order.jettons[1 - order.mainCoin]!, 'dedust');
                order.jettons[1 - order.mainCoin] = metadata!.symbol;
            }
            orderingBtns.push([{
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
            }]);
        }
    }

    orderingBtns.push([{ text: '<< Back', callback_data: 'symbol-selectdex' }]);
    let state: OrderingData = user?.state!;
    state!.state = 'ordermanage';
    updateUserState(query.message?.chat.id!, state);
    replyMessage(query.message!, `📕 Ordering Book\n\nClick order button to delete`, orderingBtns);
}

export async function handleDeleteOrderCommand(query: CallbackQuery, _:string){
    await deleteOrderingDataFromUser(query.message?.chat.id!,mongoose.Types.ObjectId.createFromHexString( _ ))
    await handleOrderingBookCommand(query);
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
            walletSecretKey: '',
            mode: ''
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
                dex: '',
                walletAddress: ''
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
                    { text: '♻️ Instant Swap', callback_data: 'symbol-selectdex-swap' },
                    {
                        text: '🏃 Book Order',
                        /*web_app:{url:'https://web.ton-rocket.com/trade'}*/ callback_data:
                            'symbol-selectdex'
                    }
                ],
                [{ text: '🏆 Exclusif:Earn Reward in TON Token', callback_data: 'exclusif' }],
                [
                    { text: '💡 Token Info', callback_data: 'token_info' },
                    {
                        text: '🚨 Alert ( soon )',
                        /*web_app:{url:'https://web.ton-rocket.com/trade'}*/ callback_data:
                            'sselectdex'
                    }
                ],
                [{ text: '🔨 Tools and Settings', callback_data: 'setting' }],
                [{ text: '🥇 Premium ( soon )', callback_data: 'seng' }]
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

export async function handleWalletDelete(query: CallbackQuery, _:string): Promise<void> {
    //change current wallet 
    const user = await getUserByTelegramID(query.message?.chat.id!);

    await deleteWalletSecret( query.message?.chat.id!,
        user!.wallets[Number(_)]!
    );
    //view refresh
    await handleShowMyWalletCommand(query.message!)
}

export async function handleWalletActivate(query: CallbackQuery, _:string): Promise<void> {
    //change current wallet 
    const user = await getUserByTelegramID(query.message?.chat.id!);
    let mnemonic = user!.wallets[Number(_)]!.split(',')
    let keyPair = await mnemonicToPrivateKey(mnemonic);

    const wallet = tonClient.open(
        WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair!.publicKey
        })
    );
    await updateWallet( query.message?.chat.id!,
        wallet.address.toString(),
        user!.wallets[Number(_)]!
    );
    //view refresh
    await handleShowMyWalletCommand(query.message!)
}

export async function handleWalletSelect(query: CallbackQuery, _: string): Promise<void> {

    const user = await getUserByTelegramID(query.message?.chat!.id!);
    let currentIndex = Number(_);
    let mnemonic = user!.wallets[currentIndex]!.split(',')
    let keyPair = await mnemonicToPrivateKey(mnemonic);

    const wallet = tonClient.open(
        WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair!.publicKey
        })
    );
    const address = wallet.address.toString();
    const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
    // const assets: Jetton[] = await fetchDataGet('/assets', 'ston');
    console.log(balances);
    let outputStr = '\nToncoin : ' + (balances[0]?.balance ? (Number(balances[0]?.balance) / 1000000000) : '0') + ' TON\n\n<b>-ALT TOKEN</b>\n';

    for(const walletAssetItem of balances)  {
        if(walletAssetItem.asset.type != 'native'){
            let asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'dedust');
            if(asset != null){
                console.log('asdfasdfasdf',asset, walletAssetItem.asset.address, asset != null)
                outputStr += asset!.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset!.decimals) + ' ' + asset!.symbol + '\n';
            } else {
                asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'ston');
                outputStr += asset!.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset!.decimals) + ' ' + asset!.symbol + '\n';
            }
        }
    };
    await replyMessage(query.message!,
        `💵 My wallet ${currentIndex}\n\nYour RewardBot Wallet address:\n <code>${address}</code>\n ${String(outputStr)}`,
        [
            [
                {text: 'Activate', callback_data: JSON.stringify({method: 'activateWallet', data:_})}, 
                {text:'Delete', callback_data: JSON.stringify({method: 'deleteWallet', data:_})}
            ],
            [{text:'back', callback_data:'showMyWallet'}]
        ] 
    )
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
                        [{text:'<< Back', callback_data: 'setting'}]
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
                        [{text:'<< Back', callback_data: 'setting'}]
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
                [{text:'<< Back', callback_data: 'setting'}]
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
                    [{text:'<< Back', callback_data: 'setting'}]
                ]
            }
        });
        return;
    }

    await connector.disconnect();

    await bot.sendMessage(chatId, '✂ Disconnect Wallet\n\n💡Wallet has been disconnected',{
        reply_markup: {
            inline_keyboard: [
                [{text:'<< Back', callback_data: 'setting'}]
            ]
        }
    });
}

export async function handleDepositCommand(query: CallbackQuery){
    const user = await getUserByTelegramID(query.message?.chat!.id!);

    replyMessage(query.message!, `📤 Deposit\n\n💡Your RewardBot Wallet Address is \n<code>${user?.walletAddress}</code>`,[[{text:'<< Back', callback_data: 'setting'}]])
}

export async function handleWithdrawCommand(query: CallbackQuery){
    
    const user = await getUserByTelegramID(query.message!.chat!.id);

    const address = user?.walletAddress;
    console.log(user);
    const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
    // const assets: Jetton[] = await fetchDataGet('/assets', user!.state.state);
    let outputStr = 'Toncoin : ' + (balances[0]?.balance ? (Number(balances[0]?.balance) / 1000000000) : '0') + ' TON\n';
    let buttons: InlineKeyboardButton[][] = [[{text:'TON', callback_data:'symbol-with-TON'}]];
    let counter = 0;
    await (async () => {
        for (const walletAssetItem of balances) {
            if (walletAssetItem.asset.type !== 'native') {
                let asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'dedust');
                if (asset === null) {
                    asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'ston');
                }
                counter++;
                console.log(asset);
                outputStr += asset!.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset!.decimals) + ' ' + asset!.symbol + '\n';
                if (buttons[Math.floor((counter + 2) / 3) ] === undefined) {
                    buttons[Math.floor((counter + 2) / 3) ] = [];
                }
                buttons[Math.floor((counter + 2) / 3)]![( counter + 2 ) % 3] = { text: asset!.symbol, callback_data: 'symbol-with-' + asset!.address };
            }
        }
    })();
    console.log(buttons)
    buttons.push([{text:'<< Back', callback_data: 'setting'}]);
    bot.sendMessage(
        query.message!.chat.id,
        `📤 Withdraw\n\n💡Please click the coin's button to withdraw\nYou shuld have enough TON on this wallet to withdraw\n\n${outputStr}`,
        { reply_markup:{ inline_keyboard:buttons }, parse_mode:'HTML' }
    );
}

export async function handleShowMyWalletCommand(msg: TelegramBot.Message): Promise<void> {

    const user = await getUserByTelegramID(msg.chat!.id);

    const address = user?.walletAddress;
    const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
    // const assets: Jetton[] = await fetchDataGet('/assets', 'ston');
    console.log(balances);
    let outputStr = '\nToncoin : ' + (balances[0]?.balance ? (Number(balances[0]?.balance) / 1000000000) : '0') + ' TON\n\n<b>-ALT TOKEN</b>\n';

    for(const walletAssetItem of balances)  {
        if(walletAssetItem.asset.type != 'native'){
            let asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'dedust');
            if(asset != null){
                console.log('asdfasdfasdf',asset, walletAssetItem.asset.address, asset != null)
                outputStr += asset!.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset!.decimals) + ' ' + asset!.symbol + '\n';
            } else {
                asset = await getAltTokenWithAddress(walletAssetItem.asset.address, 'ston');
                outputStr += asset!.name + ' : ' + (Number(walletAssetItem.balance) / 10 ** asset!.decimals) + ' ' + asset!.symbol + '\n';
            }
        }
    };
    let currentIndex = 0;
    let walletBtns: InlineKeyboardButton[][] = [
        [
            {text: "Refresh", callback_data: "showMyWallet"},
            {text: "Transfer", callback_data: JSON.stringify({method:"transferToken"})}
        ],
        [{text: "Add New Wallet", callback_data: JSON.stringify({method:"addNewWalletConfirm"})}],
    ];
    user?.wallets.map((secret, index) => {
        let emoji1 = '', emoji2 = '';
        if(secret == user.secretKey) {
            console.log(index)
            currentIndex = index;
            emoji1 = '✅ ';
            emoji2 = ' - selected'
        }
        if(!walletBtns[index + 2]) walletBtns[Math.floor((index + 2))] = [];
        let temp = secret;
        walletBtns[index + 2] = [{text:emoji1 + "Wallet " + index + emoji2, callback_data:JSON.stringify({method:'walletSelect',data:index})}]
    })
    walletBtns.push([{text:'<< Back', callback_data: 'newStart'}])
    console.log(outputStr)

    await replyMessage(msg,
        `💵 My wallet ${currentIndex}\n\nYour RewardBot Wallet address:\n <code>${address}</code>\n ${String(outputStr)}`,
        walletBtns
    )
}


export async function handleAddNewWalletConfirm(query: CallbackQuery){
    await replyMessage(query.message!,  
        `💵 Add New Wallet\n\nDo you really want to add a new wallet?`,
        [
            [
                {text:'🟢Yes', callback_data: JSON.stringify({method: 'addNewWallet'})},
                {text:'🔴No', callback_data: 'showMyWallet'},
            ],
            [
                {text:'<< Back', callback_data: 'showMyWallet'},
            ]
        ])
}

export async function handleInstanteSwap(query: CallbackQuery): Promise<void> {
    try{
        let user = await getUserByTelegramID(query.message!.chat.id);
        user!.state.state = 'trading';
        await updateUserMode(query.message?.chat.id!,"swap");
        await updateUserState(query.message?.chat!.id!, user!.state);

        // let text = `♻️ Instant Swap\n\n💡Please type in correct Jetton's Symbol/address\n  Type in CA for new published tokens.\n\nFor example:\n🔸"jUSDT", NOT "jusdt" or "JUSDT"\n🔸"EQBynBO23yw ... STQgGoXwiuA"`;
        // await bot.editMessageCaption(
        //     text,
        //     {
        //         message_id: query.message?.message_id,
        //         chat_id: query.message?.chat.id
        //     }
        // ).then(() => {})
        // .catch(async () => {
        //     await bot.editMessageText(text, {
        //         message_id: query.message?.message_id,
        //         chat_id: query.message?.chat.id,
        //         parse_mode: 'HTML'
        //     });
        // });
        // await bot.editMessageReplyMarkup(
        //     { inline_keyboard: [[{text:'<< Back', callback_data: 'newStart'}]] },
        //     {
        //         message_id: query.message?.message_id,
        //         chat_id: query.message?.chat.id
        //     }
        // );
            
    } catch (error) {
        console.log(error)
    }
}

export async function handleJettonAmount( msg: TelegramBot.Message, user: User, is_input: boolean, buttonPercent?: string){
    
    await bot.sendMessage(msg.chat.id,  `🏃 Trading\n\n💡Processing`);

    let clickedSymbol = Number (is_input ? msg.text?.replace(',', '.') : buttonPercent?.replace(',', '.'))
    if( isNaN(clickedSymbol)){
        await bot.sendMessage(
            msg.chat.id!,
            `🏃 Trading\n\n💡Please input valid amount`,
        {
            reply_markup:{
                inline_keyboard:[[ {text:'<< Back', callback_data: 'symbol-selectdex'} ]]
            }
        });
        return;
    }
    let state = user.state;
    if (state.isBuy || is_input) {
        state.amount = Number(clickedSymbol);
    } else {
        const address = user.walletAddress;
        const balances: walletAsset[] = await fetchDataGet(`/accounts/${address}/assets`, 'dedust');
        // const assets: Jetton[] = await fetchDataGet('/assets', user!.state.state);
        balances.map(async walletAssetItem => {
            if(walletAssetItem.asset.type != 'native')
                if (user!.state.jettons[1 - user!.state.mainCoin]!.length <= 10) {
                    const asset = await getAltTokenWithAddress(walletAssetItem.asset.address, user!.state.dex);
                    if(asset != null)
                        if ( asset!.symbol === user?.state.jettons[1 - user.state.mainCoin] ) {
                            console.log(asset,"ajhsdfkahsdfahs", walletAssetItem.balance);
                            state.amount =
                                Number(walletAssetItem.balance) * clickedSymbol / 10 ** asset!.decimals / 100;
                        }
                    
                } else {
                    if (
                        walletAssetItem.asset.address ===
                        user?.state.jettons[1 - user.state.mainCoin]
                    ) {
                        let matadata = await getAltTokenWithAddress(
                            walletAssetItem.asset.address,
                            user!.state.dex
                        );
                        state.amount =  Number(walletAssetItem.balance) * clickedSymbol /10 ** matadata!.decimals / 100;
                    }
                }
        });
    }
    console.log('aaaabbbbccccdddd', clickedSymbol, state.amount);
    const strPrice = await getPriceStr(
        user.state.jettons,
        user.state.mainCoin,
        user!.state.dex
    );
    let symbol;
    if (user.state.jettons[1 - user.state.mainCoin]!.length >= 10) {
        let metadata = await getAltTokenWithAddress(
            user.state.jettons[1 - user.state.mainCoin]!,
            'dedust'
        );
        symbol = metadata!.symbol;
    } else symbol = user.state.jettons[1 - user.state.mainCoin];

    if(user!.mode == 'swap'){
        user.state.state = 'amount';
        const outputAmountStr = user.state.amount.toFixed(9)
        await bot.sendMessage(msg.chat.id,
            `♻️ Instant Swap\n\n💡Please Review your new Order\nPool : ${user.state.jettons.join('/')}\nBuy/Sell : ${user.state.isBuy ? 'Buy' : 'Sell'}\nAmount : ${outputAmountStr} ${user.state.isBuy ? user.state.jettons[user.state.mainCoin] : user.state.jettons[ 1- user.state.mainCoin]} \nPrice : ${strPrice} ${user.state.jettons[user.state.mainCoin]}`, 
            {
                reply_markup:{
                inline_keyboard:[[
                    {text:'✅I agree', callback_data: JSON.stringify({ method: 'addNewOrder' })},
                    {text:'🚫I don\'t agree', callback_data: 'symbol-selectdex-swap'}
                ],[
                    {text:'<< Back', callback_data: 'symbol-selectdex-swap'}
                ]]
                }
            }
        );
    } else {
        user.state.state = 'price';

        await bot.sendMessage(
            msg.chat.id!,
            `🏃 Trading\n\n💡Input ${user.state.jettons[user.state.mainCoin]} Value for 1 ${
                symbol
            }\nWhen this value will meet for 1 ${
                symbol
            } bot will take order\nCurrent Price\n 1 ${symbol} = ${strPrice} ${user.state.jettons[user.state.mainCoin]}`,
        {
            reply_markup:{
                inline_keyboard:[[ {text:'<< Back', callback_data: 'symbol-selectdex'} ]]
            }
        });
    }
    
}

export async function handleJettonTypeSelect (msg: TelegramBot.Message, user:User, tokenAddressOrName: string){
    let typedSymbol = '',
        otherSymbol = '';
    //name, symbol, address => symbol
    const assets: Pool[] = await getPools();
    if (assets)
        assets.map(asset => {
            if (
                asset.assets[1 - asset.main]!.toUpperCase() === tokenAddressOrName.toUpperCase() ||
                (asset.caption[1 - asset.main]! === tokenAddressOrName && asset.dex === 'ston')
            ) {
                typedSymbol = 'TON/' + asset.caption[1 - asset.main]!;
                otherSymbol = asset.caption[1 - asset.main]! + '/TON';
                return;
            }
        });
    let selectedPool = await getPoolWithCaption(typedSymbol.split('/'), user!.state.dex)!;
    if (!selectedPool)
        selectedPool = await getPoolWithCaption(otherSymbol.split('/'), user!.state.dex)!;
    
    console.log(typedSymbol, otherSymbol, user!.state.state, selectedPool);
    if (!selectedPool) {
        await bot.sendMessage(
            msg?.chat.id!,
            `💡Please type in the valid Symbol OR Try other DEX`,);
        return;
    }
    user!.state.jettons = selectedPool.caption;
    user!.state.mainCoin = selectedPool!.main;
    let state = user!.state;
    state.state = 'isBuy';
    if (state.isBuy) {
        await bot.sendMessage(msg?.chat.id!,  `🏃 Trading\n\n💡Please input or click amount button of jetton in ` + state.jettons[state.mainCoin],
            {
                reply_markup:{
                    inline_keyboard:[
                        [ {text:'Buy 0.1 TON', callback_data: 'symbol-0.1'},{text:'Buy 0.3 TON', callback_data: 'symbol-0.3'} ],
                        [ {text:'Buy 0.5 TON', callback_data: 'symbol-0.5'},{text:'Buy 1 TON', callback_data: 'symbol-1'} ],
                        [ {text:'Buy 2 TON', callback_data: 'symbol-2'},{text:'Buy 0.0001 TON', callback_data: 'symbol-0.0001'} ],
                        [ {text:'<< Back', callback_data: 'symbol-selectdex'} ]
                    ]
                }
            });
    }
    else {
        await bot.sendMessage(msg?.chat.id!,  `🏃 Trading\n\n💡Please input or click amount button of jetton what you want to sell `,
            {
                reply_markup:{
                    inline_keyboard:[
                        [ {text:'Sell 5%', callback_data: 'symbol-5'},{text:'Sell 10%', callback_data: 'symbol-10'} ],
                        [ {text:'Sell 20%', callback_data: 'symbol-20'},{text:'Sell 30%', callback_data: 'symbol-30'} ],
                        [ {text:'Sell 50%', callback_data: 'symbol-50'},{text:'Sell 100%', callback_data: 'symbol-100'} ],
                        [ {text:'<< Back', callback_data: 'symbol-selectdex'} ]
                    ]
                }
            });
    }
}

export async function handleTokenInfo(query: CallbackQuery) {
    let user = await getUserByTelegramID(query.message!.chat.id);
    user!.state.state = 'token_info';
    await updateUserState(query.message!.chat.id, user!.state);
    await replyMessage(query.message!, `💡 Token Info \n\nPlease Type in the CA of Token`,[[{text:'<< Back', callback_data: 'newStart'}]]);
}
export async function handleTransferToken(query: CallbackQuery) {
    const user = await getUserByTelegramID(query.message!.chat!.id);
    user!.state.state = 'getTargetAddress';
    await updateUserState(query.message!.chat!.id, user!.state);
    await replyMessage( query.message!, 
        `💸 Transfer\n\nPlease type in the target wallet address`,
        [[{ text: '<< Back', callback_data: 'showMyWallet' }]]
    )
}