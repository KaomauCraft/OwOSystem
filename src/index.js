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
  EmbedBuilder
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
  deliveryCounter: 0
});

let inventory = readJson(CODES_FILE, []);
let inventoryBusy = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

function isStaff(member) {
  return member.roles.cache.has(config.roles.owner) ||
    member.roles.cache.has(config.roles.distributor);
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
      // Panel silinmişse yeniden oluştur.
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

client.on('interactionCreate', async interaction => {
  try {
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
      return interaction.reply({ content: `Destek kanalınız oluşturuldu: ${channel}`, ephemeral: true });
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

        await channel.send({
          content: `Merhaba ${interaction.user}, teslimat talebiniz alındı. OTM ekibi sizinle bu kanaldan ilgilenecek.\n\n**Teslimat No:** ${number}\n**Kod miktarı:** ${Number(match[2]).toLocaleString('tr-TR')} OwO Cash`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('otm_ticket_close').setLabel('Ticket Kapat').setStyle(ButtonStyle.Danger)
          )]
        });

        const deliveryChannel = await interaction.guild.channels.fetch(config.channels.delivery);
        if (deliveryChannel && deliveryChannel.isTextBased()) {
          await deliveryChannel.send({
            embeds: [new EmbedBuilder()
              .setColor(0xF1C40F)
              .setTitle('Yeni Teslimat Talebi')
              .setDescription(`**Kullanıcı:** ${interaction.user.tag}\n**Teslimat:** ${channel}\n**Teslimat No:** ${number}\n**Miktar:** ${Number(match[2]).toLocaleString('tr-TR')} OwO Cash`)
              .setTimestamp()]
          });
        }

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
