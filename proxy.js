const net = require('net');
const fs = require('fs');


if (!fs.existsSync('settings.json')) {

    console.log("Settings not exist.")

    const default_settings = {
        server_host: '127.0.0.1',
        server_port: 25565,
        proxy_host: '0.0.0.0',
        proxy_port: 25566,
        tgbot_token: '',
        mcid2chatid: {}
    };

    const data = JSON.stringify(default_settings);

    fs.writeFileSync('settings.json', data, (err) => {
        if (err) {
            console.error(err);
            exit()
        }
    });
}

const data = fs.readFileSync('settings.json', 'utf8');
//warning: race condition
const map = JSON.parse(data);
console.log(map);

const TelegramBot = require('node-telegram-bot-api');

const token = map.tgbot_token;


const bot = new TelegramBot(token, { polling: true });

function bind(mcid, chatid) {

    map.mcid2chatid[mcid] = chatid

    console.log(map);

    const data = JSON.stringify(map);

    fs.writeFileSync('settings.json', data, (err) => {
        if (err) {
            console.error(err);
            exit()
        }
    });
}

bot.onText(/\/bind/, (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;

    const mcid = messageText.split(" ")[1]

    if (typeof mcid !== "undefined") {
        bot.sendMessage(chatId, `bind ${mcid} to ${chatId}`);
        bind(mcid, chatId)
    }

});

let login_requests = {}


async function request_verify(mcid) {

    const chatid = map.mcid2chatid[mcid]

    if (typeof chatid === "undefined") {
        return
    }

    const keyboard = [
        [{ text: 'Accept', callback_data: 'accept' }],
        [{ text: 'Reject', callback_data: 'reject' }],
    ];

    bot.sendMessage(chatid, 'Please choose one of the options', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });

    return await Promise.race([

        new Promise((resolve) => {
            setTimeout(resolve, 10000, false)
        }),

        new Promise(async (resolve) => {
            await new Promise((resolve) => {
                login_requests[chatid] = resolve
            })
            setTimeout(resolve, 0, true)
        }),

    ]);
}


bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    bot.editMessageReplyMarkup({}, { chat_id: chatId, message_id: query.message.message_id });

    switch (data) {
        case 'accept':
            let handle = login_requests[chatId]
            handle()
            break;
        case 'reject':
            break;
        default:
            bot.sendMessage(chatId, 'Invalid option');
    }

});
const proxyServer = net.createServer((clientSocket) => {

    let buffer = Buffer.alloc(0);


    const targetSocket = net.connect(map.server_port, map.server_host, () => {
        targetSocket.pipe(clientSocket);
    });

    function readVarIntFromBuffer(buffer) {
        let value = 0;
        let shift = 0;
        let bytesRead = 0;

        for (let i = 0; i < buffer.length; i++) {
            const byte = buffer[i];
            bytesRead++;

            value |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                return { value, bytesRead };
            } else {
                shift += 7;
            }
        }
        return { error: 'Incomplete VarInt' };
    }

    const beforeLoginListenser = async (data) => {

        // console.log(`${data.toString('hex')}`)

        buffer = Buffer.concat([buffer, data])

        while (buffer.length > 0) {
            const {
                value: pkt_playload_len,
                bytesRead: pkt_varint_len,
                error
            } = readVarIntFromBuffer(buffer);


            if (error) {
                break;
            }

            if (buffer.length < pkt_varint_len + pkt_playload_len) {
                break;
            }

            let pkt = buffer.subarray(0, pkt_varint_len + pkt_playload_len)
            let pkt_id = pkt[pkt_varint_len]
            let next_state = pkt[pkt_varint_len + pkt_playload_len - 1]
            if (pkt_id == 0x00 && next_state == 0x02) {
                //next state is login. Let's start login process

                let login_pkt = buffer.subarray(pkt_varint_len + pkt_playload_len)
                const {
                    value: login_pkt_payload_len,
                    bytesRead: login_pkt_varint_len,
                    error
                } = readVarIntFromBuffer(login_pkt)
                if (error || login_pkt.length < pkt_playload_len + pkt_varint_len) {
                    break
                } else {
                    //login pkt ready
                    let username_idx = login_pkt_varint_len + 1
                    let username_len = login_pkt[username_idx]
                    let username = login_pkt.subarray(username_idx + 1, username_idx + 1 + username_len)

                    console.log(`${username} request to login`)

                    if (await request_verify(username)) {

                        console.log(`${username} login success`)

                        //login success.
                        targetSocket.write(buffer)
                        clientSocket.pipe(targetSocket);
                        clientSocket.removeListener('data', beforeLoginListenser);

                    } else {

                        targetSocket.end("")
                        clientSocket.end("")
                        console.log(`${username} login timeout`)

                    }

                    break

                }

            } else {
                //login process not start yet
                targetSocket.write(pkt)
                buffer = buffer.subarray(pkt.length)
            }

        }

    }

    clientSocket.on('error', () => {
        targetSocket.end();
    });

    targetSocket.on('error', () => {
        clientSocket.end();
    });

    clientSocket.on('close', () => {
        targetSocket.end();
    });

    targetSocket.on('close', () => {
        clientSocket.end();
    });

    clientSocket.on('data', beforeLoginListenser);

});

proxyServer.listen(map.proxy_port, map.proxy_host, () => {
});
