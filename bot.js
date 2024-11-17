require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const axios = require('axios');

// Initialize the bot and use session middleware
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

const HYGRAPH_API = process.env.HYGRAPH_API_URL;
const HYGRAPH_API_TOKEN = process.env.HYGRAPH_API_TOKEN;

// Rate-limiting configuration
const rateLimit = {};
const LIMIT = 5; // Maximum requests per user
const TIME_WINDOW = 60000; // Time window in milliseconds (1 minute)

// Middleware for rate-limiting
bot.use((ctx, next) => {
  const userId = ctx.from.id; // Get user ID
  const now = Date.now(); // Get current timestamp

  // Initialize or clean up user's request history
  if (!rateLimit[userId]) {
    rateLimit[userId] = [];
  }
  rateLimit[userId] = rateLimit[userId].filter(
    (timestamp) => now - timestamp < TIME_WINDOW
  );

  // If user exceeds the limit, block further requests
  if (rateLimit[userId].length >= LIMIT) {
    return ctx.reply(
      'You are sending too many requests. Please try again later.'
    );
  }

  // Log the current request
  rateLimit[userId].push(now);
  return next();
});

// Helper function to query the Hygraph API
const requestHygraph = async (query, variables) => {
  try {
    const response = await axios.post(
      HYGRAPH_API,
      { query, variables },
      { headers: { Authorization: `Bearer ${HYGRAPH_API_TOKEN}` } }
    );
    return response.data;
  } catch (error) {
    console.error(
      'Error fetching from Hygraph:',
      error.response?.data || error
    );
  }
};

// Blood group options
const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Donor Registration Wizard Scene
const donorRegistrationWizard = new Scenes.WizardScene(
  'donor-registration',
  async (ctx) => {
    ctx.wizard.state.donorInfo = {};
    await ctx.reply('Please provide your phone number:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.donorInfo.phoneNumber = ctx.message.text;
    await ctx.reply('Please provide your blood group:', {
      reply_markup: {
        keyboard: bloodGroups.map((bg) => [bg]),
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });
    return ctx.wizard.next();
  },
  async (ctx) => {
    const bloodGroup = ctx.message.text;
    if (!bloodGroups.includes(bloodGroup)) {
      await ctx.reply(
        'Please select a valid blood group from the options provided.'
      );
      return;
    }
    ctx.wizard.state.donorInfo.bloodGroup = bloodGroup;
    await ctx.reply('Please provide your last donation date (yyyy-mm-dd):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const date = ctx.message.text;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await ctx.reply('Please enter the date in yyyy-mm-dd format.');
      return;
    }
    ctx.wizard.state.donorInfo.lastDonationDate = date;
    await ctx.reply(
      'Please provide your location (Locality, Panchayat, District):'
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.donorInfo.location = ctx.message.text;
    const donorInfo = ctx.wizard.state.donorInfo;
    const userId = ctx.from.id;
    const name = `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
    const mutation = `
      mutation($data: DonorCreateInput!) {
        createDonor(data: $data) {
          id
          name
        }
      }
    `;
    const locationParts = donorInfo.location
      .split(',')
      .map((part) => part.trim());
    const variables = {
      data: {
        telegramId: String(userId),
        name: name,
        phoneNumber: donorInfo.phoneNumber,
        bloodGroup: donorInfo.bloodGroup,
        lastDonationDate: donorInfo.lastDonationDate,
        location: {
          create: {
            locality: locationParts[0] || '',
            panchayat: locationParts[1] || '',
            district: locationParts[2] || '',
          },
        },
      },
    };
    await requestHygraph(mutation, variables);
    await ctx.reply(
      'You have successfully registered as a blood donor! Thank you for your willingness to donate.',
      { reply_markup: { remove_keyboard: true } }
    );
    return ctx.scene.leave();
  }
);

// Blood Request Wizard Scene
const bloodRequestWizard = new Scenes.WizardScene(
  'blood-request',
  async (ctx) => {
    ctx.wizard.state.requestData = {};
    await ctx.reply('What is your blood group?', {
      reply_markup: {
        keyboard: bloodGroups.map((bg) => [bg]),
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });
    return ctx.wizard.next();
  },
  async (ctx) => {
    const bloodGroup = ctx.message.text;
    if (!bloodGroups.includes(bloodGroup)) {
      await ctx.reply(
        'Please select a valid blood group from the options provided.'
      );
      return;
    }
    ctx.wizard.state.requestData.bloodGroup = bloodGroup;
    await ctx.reply('How many units of blood do you need?');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const unitsNeeded = Number.parseInt(ctx.message.text, 10);
    if (isNaN(unitsNeeded) || unitsNeeded <= 0) {
      await ctx.reply('Please enter a valid number for units needed.');
      return;
    }
    ctx.wizard.state.requestData.unitsNeeded = unitsNeeded;
    await ctx.reply('Enter your location (Locality, Panchayat, District):');
    return ctx.wizard.next();
  },
  async (ctx) => {
    ctx.wizard.state.requestData.location = ctx.message.text;
    const requestData = ctx.wizard.state.requestData;
    const query = `
      query($bloodGroup: String!, $location: String!) {
        donors(where: { bloodGroup: $bloodGroup, location_contains: $location }) {
          name
          phoneNumber
          location {
            locality
            panchayat
            district
          }
        }
      }
    `;
    const variables = {
      bloodGroup: requestData.bloodGroup,
      location: requestData.location,
    };
    const donorsResponse = await requestHygraph(query, variables);
    if (donorsResponse?.data?.donors?.length > 0) {
      const donorsList = donorsResponse.data.donors
        .map(
          (donor) => `
Name: ${donor.name}
Contact: ${donor.phoneNumber}
Location: ${donor.location.locality}, ${donor.location.panchayat}, ${donor.location.district}
          `
        )
        .join('\n\n');
      await ctx.reply(
        `We found eligible donors for your request:\n\n${donorsList}`,
        {
          reply_markup: { remove_keyboard: true },
        }
      );
    } else {
      await ctx.reply('Sorry, no donors are available at the moment.', {
        reply_markup: { remove_keyboard: true },
      });
    }
    return ctx.scene.leave();
  }
);

// Add scenes to the stage
const stage = new Scenes.Stage([donorRegistrationWizard, bloodRequestWizard]);
bot.use(stage.middleware());

// Start command
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const name = `${ctx.from.first_name} ${ctx.from.last_name || ''}`.trim();
  const query = `
    query($telegramId: String!) {
      donors(where: { telegramId: $telegramId }) {
        id
        name
      }
    }
  `;
  const vars = { telegramId: String(userId) };
  const donorResponse = await requestHygraph(query, vars);
  if (donorResponse?.data?.donors?.length > 0) {
    ctx.reply(`Welcome back, ${name}! You are already a registered donor.`);
  } else {
    ctx.reply(
      `Welcome ${name}!\n\nCommands:\n- /beadonor: Register as a donor\n- /requestblood: Request blood`
    );
  }
});

// Register command handlers
bot.command('beadonor', async (ctx) => {
  await ctx.scene.enter('donor-registration');
});

bot.command('requestblood', async (ctx) => {
  await ctx.scene.enter('blood-request');
});

// Launch the bot
bot.launch();
console.log('Bot is up and running.');
