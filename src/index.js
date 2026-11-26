require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  SlashCommandBuilder
} = require('discord.js');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

const state = readJson(STATE_FILE, {
  supportPanelMessageId: null,
  deliveryPanelMessageId: null,
  supportCounter: 0,
  deliveryCounter: 0,
  owoCashPriceMessageId: null
});

let inventory = readJson(CODES_FILE, []);
let inventoryBusy = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

function isStaff(member) {
  return member.roles.cache.has(config.roles.owner) ||
    member.roles.cache.has(config.roles.distributor);
}

function getTopicValue(topic, key) {
  const match = new RegExp('(?:^|;)' + key + '=([^;]+)(?:;|$)').exec(topic || '');
  return match ? match[1] : null;
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(days + ' Gün');
  if (hours) parts.push(hours + ' Saat');
  if (minutes || parts.length === 0) parts.push(minutes + ' Dakika');
  return parts.join(' ');
}

async function sendLog(guild, title, description, color = 0x5865F2) {
  try {
    const logChannel = await guild.channels.fetch(config.channels.logs);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({
        embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp()]
      });
    }
  } catch (error) {
    console.error('[OTM] Log gönderilemedi:', error);
  }
}

function safeChannelPart(value) {
  return String(value || 'kullanici')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'kullanici';
}

function nextNumber(kind) {
  const key = kind === 'support' ? 'supportCounter' : 'deliveryCounter';
  state[key] = Number(state[key] || 0) + 1;
  writeJson(STATE_FILE, state);
  return String(state[key]).padStart(4, '0');
}

async function createPrivateChannel(guild, categoryId, name, user, ticketType, number) {
  const everyone = guild.roles.everyone;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: `otm-ticket;owner=${user.id};type=${ticketType};number=${number}`,
    permissionOverwrites: [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles
        ]
      },
      {
        id: config.roles.owner,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels
        ]
      },
      {
        id: config.roles.distributor,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels
        ]
      }
    ]
  });
}

async function ensurePanel(guild, channelId, stateKey, embed, button) {
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    console.error('Panel kanalı bulunamadı:', channelId);
    return;
  }

  // Teslimat kanalında üyeler mesaj gönderemez; bot panel ve teslimat duyurularını gönderebilir.
  if (stateKey === 'deliveryPanelMessageId') {
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false
    });
    // Rol izinleri @everyone engelini aşabileceği için tüm sunucu rollerine de yazma kapatılır.
    for (const role of guild.roles.cache.values()) {
      if (role.id !== guild.roles.everyone.id) {
        await channel.permissionOverwrites.edit(role.id, { SendMessages: false });
      }
    }
    await channel.permissionOverwrites.edit(client.user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true
    });
  }

  const savedId = state[stateKey];
  if (savedId) {
    try {
      const existing = await channel.messages.fetch(savedId);
      if (existing) return;
    } catch {
      // Kayıtlı panel bulunamazsa kanal geçmişinde arama yapılır.
    }
  }

  // Hosting yeniden başlatıldığında state.json sıfırlansa bile mevcut paneli bul.
  // Böylece her açılışta aynı panelin tekrar gönderilmesi engellenir.
  const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (recentMessages) {
    const existingPanel = recentMessages.find(message =>
      message.author.id === client.user.id &&
      message.embeds.some(item => item.title === embed.data.title) &&
      message.components.some(row =>
        row.components.some(component => component.customId === button.data.custom_id)
      )
    );

    if (existingPanel) {
      state[stateKey] = existingPanel.id;
      writeJson(STATE_FILE, state);
      console.log(`[OTM] Mevcut panel bulundu, tekrar gönderilmedi: ${stateKey}`);
      return;
    }
  }

  const message = await channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)]
  });
  state[stateKey] = message.id;
  writeJson(STATE_FILE, state);
}

client.once('ready', async () => {
  console.log(`[OTM] ${client.user.tag} olarak giriş yapıldı.`);
  const guild = await client.guilds.fetch(config.guildId);

  // OwO Cash fiyat listesini kutulu embed olarak gönder/güncelle.
  try {
    const owoChannel = await guild.channels.fetch(config.channels.discordOwo);
    if (!owoChannel || !owoChannel.isTextBased()) {
      throw new Error('OwO Cash kanalı bulunamadı veya yazı kanalı değil.');
    }

    await guild.emojis.fetch();
    let owoEmoji = guild.emojis.cache.find(emoji => emoji.name === 'owo_cash');
    if (!owoEmoji) {
      const response = await fetch('https://cdn3.emoji.gg/emojis/86782-owo.gif');
      if (!response.ok) throw new Error('owo_cash görseli indirilemedi.');
      owoEmoji = await guild.emojis.create({
        attachment: Buffer.from(await response.arrayBuffer()),
        name: 'owo_cash',
        reason: 'OwO Cash fiyat listesinde kullanılacak sunucu emojisi'
      });
    }

    const icon = owoEmoji.toString();
    const priceEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🛒・OwO Cash Fiyat Listesi')
      .setDescription([
        `${icon} **100.000 OwO Cash = 1 TL**`,
        `${icon} **200.000 OwO Cash = 2 TL**`,
        `${icon} **300.000 OwO Cash = 3 TL**`,
        `${icon} **400.000 OwO Cash = 4 TL**`,
        `${icon} [**500.000 OwO Cash = 5 TL**](https://hesap.com.tr/ilan/1522239-500000-owo-cash-otomatik-teslimat)`,
        `${icon} **600.000 OwO Cash = 6 TL**`,
        `${icon} **700.000 OwO Cash = 7 TL**`,
        `${icon} **800.000 OwO Cash = 8 TL**`,
        `${icon} **900.000 OwO Cash = 9 TL**`,
        `${icon} [**1.000.000 OwO Cash = 10 TL**](https://hesap.com.tr/ilan/1522282-1000000-owo-cash-otomatik-teslimat)`
      ].join('\\n'))
      .setFooter({ text: 'Satın almak için bağlantılı fiyatlara tıklayabilirsin.' });

    let existingPriceMessage = null;
    if (state.owoCashPriceMessageId) {
      existingPriceMessage = await owoChannel.messages.fetch(state.owoCashPriceMessageId).catch(() => null);
    }
    if (!existingPriceMessage) {
      const recentMessages = await owoChannel.messages.fetch({ limit: 100 }).catch(() => null);
      existingPriceMessage = recentMessages?.find(message =>
        message.author.id === client.user.id &&
        (message.content.includes('OwO Cash Fiyat Listesi') ||
          message.embeds.some(embed => embed.title?.includes('OwO Cash Fiyat Listesi')))
      ) || null;
    }

    if (existingPriceMessage) {
      await existingPriceMessage.edit({
        content: '',
        embeds: [priceEmbed],
        allowedMentions: { parse: [] }
      });
      state.owoCashPriceMessageId = existingPriceMessage.id;
      writeJson(STATE_FILE, state);
      console.log('[OTM] OwO Cash fiyat listesi kutulu tasarımla güncellendi.');
    } else {
      const sentMessage = await owoChannel.send({
        embeds: [priceEmbed],
        allowedMentions: { parse: [] }
      });
      state.owoCashPriceMessageId = sentMessage.id;
      writeJson(STATE_FILE, state);
      console.log('[OTM] OwO Cash fiyat listesi kutulu tasarımla gönderildi.');
    }
  } catch (error) {
    console.error('[OTM] OwO Cash fiyat listesi gönderilemedi/güncellenemedi:', error);
  }

  // OwO Cash animasyonlu sunucu emojisini yalnızca bir kez oluştur.
  try {
    await guild.emojis.fetch();
    const emojiDefinitions = [
      { name: 'owo_cash', url: 'https://cdn3.emoji.gg/emojis/86782-owo.gif', reason: 'OwO Cash emojisi' },
      { name: 'offline', url: 'https://cdn3.emoji.gg/emojis/11877-offline.png', reason: 'Offline emojisi' }
    ];
    for (const definition of emojiDefinitions) {
      const existingEmoji = guild.emojis.cache.find(emoji => emoji.name === definition.name);
      if (existingEmoji) {
        console.log(`[OTM] :${definition.name}: emojisi zaten mevcut, tekrar oluşturulmadı.`);
        continue;
      }
      const emojiResponse = await fetch(definition.url);
      if (!emojiResponse.ok) throw new Error(`${definition.name} görseli indirilemedi: HTTP ${emojiResponse.status}`);
      const emojiBuffer = Buffer.from(await emojiResponse.arrayBuffer());
      const createdEmoji = await guild.emojis.create({
        attachment: emojiBuffer,
        name: definition.name,
        reason: definition.reason
      });
      console.log(`[OTM] Sunucu emojisi oluşturuldu: :${createdEmoji.name}:`);
    }
  } catch (error) {
    console.error('[OTM] owo_cash emojisi eklenemedi. Botta Emojileri Yönet izni olduğundan emin olun:', error);
  }

  await guild.commands.set([
    new SlashCommandBuilder()
      .setName('botyaz')
      .setDescription('Bot üzerinden seçilen kanala mesaj gönderir.')
      .addChannelOption(option =>
        option.setName('kanal')
          .setDescription('Mesajın gönderileceği kanal')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addStringOption(option =>
        option.setName('mesaj')
          .setDescription('Botun göndereceği mesaj')
          .setRequired(true)
          .setMaxLength(2000)
      )
      .toJSON()
  ]);

  const supportEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('OTM | Destek Merkezi')
    .setDescription('Destek talebi oluşturmak için aşağıdaki butona basın. Size özel bir destek kanalı açılacaktır.');

  const deliveryEmbed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('OTM | Teslimat Merkezi')
    .setDescription('Hesap.com.tr üzerinden aldığınız, henüz kullanılmamış OTM stok kodunuzu girmek için aşağıdaki butona basın.\n\nÖrnek biçim: `OTM-687567-100000`');

  await ensurePanel(
    guild,
    config.channels.support,
    'supportPanelMessageId',
    supportEmbed,
    new ButtonBuilder().setCustomId('otm_support_create').setLabel('Destek Oluştur').setStyle(ButtonStyle.Primary)
  );

  await ensurePanel(
    guild,
    config.channels.delivery,
    'deliveryPanelMessageId',
    deliveryEmbed,
    new ButtonBuilder().setCustomId('otm_delivery_create').setLabel('Teslimat Oluştur').setStyle(ButtonStyle.Success)
  );
});

client.on('guildMemberAdd', async member => {
  try {
    const roleId = member.user.bot ? config.roles.bot : config.roles.member;
    if (!roleId) {
      console.error('[OTM] Giriş rolü ayarlanmamış:', member.user.bot ? 'bot' : 'üye');
      return;
    }
    await member.roles.add(roleId, member.user.bot
      ? 'Sunucuya katılan bot/uygulama hesabı'
      : 'Sunucuya katılan gerçek kullanıcı');
    await sendLog(
      member.guild,
      member.user.bot ? 'Sunucuya Bot / Uygulama Katıldı' : 'Yeni Üye Katıldı',
      `Hesap: ${member.user.tag} (${member.id})\nVerilen rol: <@&${roleId}>`,
      member.user.bot ? 0x95A5A6 : 0x2ECC71
    );
  } catch (error) {
    console.error('[OTM] Otomatik giriş rolü verilemedi:', error);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'botyaz') {
      if (!isStaff(interaction.member)) {
        return interaction.reply({
          content: 'Bu komutu yalnızca OTM sahibi ve yetkilileri kullanabilir.',
          ephemeral: true
        });
      }

      const target = interaction.options.getChannel('kanal', true);
      const messageText = interaction.options.getString('mesaj', true).trim();
      if (!messageText) {
        return interaction.reply({ content: 'Gönderilecek mesaj boş olamaz.', ephemeral: true });
      }
      if (!target.isTextBased() || typeof target.send !== 'function' || target.guildId !== interaction.guildId) {
        return interaction.reply({ content: 'Geçerli bir sunucu yazı kanalı seçmelisin.', ephemeral: true });
      }

      await target.send({
        content: messageText,
        allowedMentions: { parse: [] }
      });
      await sendLog(
        interaction.guild,
        'Bot Üzerinden Mesaj Gönderildi',
        `Gönderen: ${interaction.user.tag} (${interaction.user.id})\\nKanal: ${target}\\nMesaj: ${messageText.slice(0, 900)}`
      );
      return interaction.reply({ content: `Mesaj başarıyla ${target} kanalına gönderildi.`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId === 'otm_support_create') {
      const guild = interaction.guild;
      const number = nextNumber('support');
      const channelName = `otm-${safeChannelPart(interaction.user.username)}-destek-${number}`;
      const channel = await createPrivateChannel(guild, config.categories.support, channelName, interaction.user, 'support', number);

      await channel.send({
        content: `Merhaba ${interaction.user}, destek talebiniz oluşturuldu. Sorununuzu buraya yazabilirsiniz.\n\nDestek numarası: **${number}**`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('otm_ticket_close').setLabel('Ticket Kapat').setStyle(ButtonStyle.Danger)
        )]
      });
      await sendLog(guild, 'Yeni Destek Talebi', `Üye: ${interaction.user.tag} (${interaction.user.id})\nTicket: ${channel}\nTalep No: ${number}`);
      return interaction.reply({ content: `Destek kanalınız oluşturuldu: ${channel}`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('otm_delivery_complete:')) {
      if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Bu işlemi yalnızca OTM yetkilileri tamamlayabilir.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const ticketChannelId = interaction.customId.split(':')[1];
      const ticketChannel = await interaction.guild.channels.fetch(ticketChannelId).catch(() => null);
      if (!ticketChannel || !ticketChannel.topic || !ticketChannel.topic.startsWith('otm-ticket;')) {
        return interaction.editReply('Teslimat ticketı bulunamadı veya artık geçerli değil.');
      }

      const ownerId = getTopicValue(ticketChannel.topic, 'owner');
      const amount = Number(getTopicValue(ticketChannel.topic, 'amount'));
      const createdAt = Number(getTopicValue(ticketChannel.topic, 'created'));
      if (!ownerId || !Number.isFinite(amount) || !createdAt || getTopicValue(ticketChannel.topic, 'completed') === 'true') {
        return interaction.editReply('Teslimat bilgileri eksik veya bu işlem daha önce tamamlanmış.');
      }

      const memberUser = await client.users.fetch(ownerId).catch(() => null);
      if (!memberUser) return interaction.editReply('Üye hesabı bulunamadı; işlem tamamlanamadı.');

      const waited = formatDuration(Date.now() - createdAt);
      const proofChannel = await interaction.guild.channels.fetch(config.channels.deliveryProof);
      if (!proofChannel || !proofChannel.isTextBased()) {
        return interaction.editReply('Teslimat kanıt kanalı bulunamadı. Kanal ID ayarını kontrol edin.');
      }

      const proofEmbed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('TESLİMAT TAMAMLANDI')
        .addFields(
          { name: 'Üye', value: `${memberUser} (${memberUser.id})`, inline: false },
          { name: 'Gönderilen OwO Miktarı', value: `${amount.toLocaleString('tr-TR')} OwO Cash`, inline: true },
          { name: 'Beklediği Süre', value: waited, inline: true },
          { name: 'İşlemi Gerçekleştiren Yetkili', value: `${interaction.user}`, inline: false }
        )
        .setTimestamp();

      await proofChannel.send({ embeds: [proofEmbed] });
      await ticketChannel.setTopic(ticketChannel.topic + ';completed=true');

      let dmSent = true;
      await memberUser.send({
        embeds: [new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('OwO Teslimatınız Tamamlandı!')
          .setDescription(`Merhaba! **${amount.toLocaleString('tr-TR')} OwO Cash** teslimatınız tamamlandı.\n\nİyi günlerde kullanın!`)
          .setTimestamp()]
      }).catch(() => { dmSent = false; });

      await interaction.message.delete().catch(() => {});
      await sendLog(
        interaction.guild,
        'OwO Teslimatı Tamamlandı',
        `Üye: ${memberUser.tag} (${memberUser.id})\nMiktar: ${amount.toLocaleString('tr-TR')} OwO Cash\nBekleme süresi: ${waited}\nYetkili: ${interaction.user.tag} (${interaction.user.id})\nTicket: #${ticketChannel.name}\nDM: ${dmSent ? 'Gönderildi' : 'Gönderilemedi'}`,
        0x2ECC71
      );
      return interaction.editReply(dmSent
        ? 'Teslimat tamamlandı. Kanıt mesajı gönderildi, üye DM ile bilgilendirildi ve bekleme kaydı kaldırıldı.'
        : 'Teslimat tamamlandı ve kanıt mesajı gönderildi. Ancak üyenin DM kutusu kapalı olduğu için DM iletilemedi.');
    }

    if (interaction.isButton() && interaction.customId === 'otm_ticket_close') {
      const channel = interaction.channel;
      const topic = channel?.topic || '';
      const ownerMatch = /(?:^|;)owner=(\d+)(?:;|$)/.exec(topic);
      const isOtmTicket = topic.startsWith('otm-ticket;') && ownerMatch;
      if (!isOtmTicket) {
        return interaction.reply({ content: 'Bu kanal geçerli bir OTM ticket kanalı değil.', ephemeral: true });
      }

      const isOwner = ownerMatch[1] === interaction.user.id;
      if (!isOwner && !isStaff(interaction.member)) {
        return interaction.reply({ content: 'Bu ticketı yalnızca ticket sahibi veya OTM yetkilileri kapatabilir.', ephemeral: true });
      }

      await interaction.reply({ content: 'Ticket kapatılıyor...', ephemeral: true });
      await sendLog(
        interaction.guild,
        'Ticket Kapatıldı',
        `Kanal: #${channel.name}\nTicket sahibi ID: ${ownerMatch[1]}\nKapatan: ${interaction.user.tag} (${interaction.user.id})`
      );
      await channel.delete(`OTM ticket ${interaction.user.tag} tarafından kapatıldı.`);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'otm_delivery_create') {
      const modal = new ModalBuilder()
        .setCustomId('otm_delivery_code_modal')
        .setTitle('Teslimat Kodu');

      const codeInput = new TextInputBuilder()
        .setCustomId('stock_code')
        .setLabel('OTM stok kodunuz')
        .setPlaceholder('OTM-687567-100000')
        .setStyle(TextInputStyle.Short)
        .setMinLength(15)
        .setMaxLength(32)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'otm_delivery_code_modal') {
      await interaction.deferReply({ ephemeral: true });

      if (inventoryBusy) {
        return interaction.editReply('Stok kontrolü şu anda meşgul. Biraz sonra tekrar deneyin.');
      }

      const submitted = interaction.fields.getTextInputValue('stock_code').trim().toUpperCase();
      const match = /^OTM-(\d{6})-(\d{1,12})$/.exec(submitted);

      if (!match) {
        return interaction.editReply('Kod biçimi geçersiz. Örnek: `OTM-687567-100000`');
      }

      inventoryBusy = true;
      try {
        inventory = readJson(CODES_FILE, []);
        const codeEntry = inventory.find(item =>
          item && item.code === submitted && item.used !== true
        );

        if (!codeEntry) {
          return interaction.editReply('Bu kod stokta bulunamadı, daha önce kullanılmış veya geçersiz.');
        }

        const number = nextNumber('delivery');
        const channelName = `otm-${safeChannelPart(interaction.user.username)}-teslimat-${number}`;
        const channel = await createPrivateChannel(
          interaction.guild,
          config.categories.deliveryWaiting,
          channelName,
          interaction.user,
          'delivery',
          number
        );

        codeEntry.used = true;
        codeEntry.usedBy = interaction.user.id;
        codeEntry.usedAt = new Date().toISOString();
        writeJson(CODES_FILE, inventory);

        const amount = Number(match[2]);
        const createdAt = Date.now();
        await channel.setTopic(channel.topic + `;amount=${amount};created=${createdAt}`);

        await channel.send({
          content: `Merhaba ${interaction.user}, teslimat talebiniz alındı. OTM ekibi sizinle bu kanaldan ilgilenecek.\n\n**Teslimat No:** ${number}\n**Kod miktarı:** ${amount.toLocaleString('tr-TR')} OwO Cash`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('otm_ticket_close').setLabel('Ticket Kapat').setStyle(ButtonStyle.Danger)
          )]
        });

        // Bekleyen teslimat bildirimi ve "İşlem Tamamlandı" butonu yalnızca teslimat-bekliyor kanalına gönderilir.
        const deliveryChannel = await interaction.guild.channels.fetch(config.channels.deliveryWaitingChannel);
        if (deliveryChannel && deliveryChannel.isTextBased()) {
          const queueEmbed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle('BEKLEYEN OWО TESLİMATI')
            .setDescription(`**Üye:** ${interaction.user} (${interaction.user.tag})\n**Üye ID:** ${interaction.user.id}\n**Gönderilecek OwO Miktarı:** ${amount.toLocaleString('tr-TR')} OwO Cash\n**Bekleme Süresi:** <t:${Math.floor(createdAt / 1000)}:R>\n**Ticket:** ${channel}\n**Teslimat No:** ${number}`)
            .setTimestamp(new Date(createdAt));
          const queueMessage = await deliveryChannel.send({
            embeds: [queueEmbed],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`otm_delivery_complete:${channel.id}`)
                .setLabel('İşlem Tamamlandı')
                .setStyle(ButtonStyle.Success)
            )]
          });
          await channel.setTopic(channel.topic + `;queue=${queueMessage.id}`);
        }

        await sendLog(
          interaction.guild,
          'Yeni OwO Teslimat Talebi',
          `Üye: ${interaction.user.tag} (${interaction.user.id})\nMiktar: ${amount.toLocaleString('tr-TR')} OwO Cash\nTeslimat No: ${number}\nTicket: ${channel}`,
          0xF1C40F
        );

        return interaction.editReply(`Kod doğrulandı. Teslimat talebiniz oluşturuldu: ${channel}`);
      } finally {
        inventoryBusy = false;
      }
    }
  } catch (error) {
    console.error('[OTM] Etkileşim hatası:', error);
    const message = 'İşlem sırasında bir hata oluştu. Lütfen OTM ekibiyle iletişime geçin.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
