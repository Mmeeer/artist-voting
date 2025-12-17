const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nye-voting';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nye2025';

app.use(cors());
app.use(express.json());

// MongoDB Schema Definitions
const companySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const optionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  imageUrl: { type: String }
}, { _id: false });

const sectionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  type: {
    type: String,
    required: true,
    enum: ['single-select', 'multi-select', 'text-input']
  },
  required: { type: Boolean, default: true },
  options: [optionSchema],
  minSelections: { type: Number, default: 1 },
  maxSelections: { type: Number, default: 1 }
}, { _id: false });

// Global voting session (only one active at a time)
const votingSessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  sections: [sectionSchema],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const voteSchema = new mongoose.Schema({
  votingSessionId: { type: String, required: true, index: true },
  companyId: { type: String, required: true, index: true },
  votes: { type: Map, of: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now },
  ipAddress: { type: String },
  deviceId: { type: String, index: true }
});

const Company = mongoose.model('Company', companySchema);
const VotingSession = mongoose.model('VotingSession', votingSessionSchema);
const Vote = mongoose.model('Vote', voteSchema);

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

async function getCurrentVoting() {
  return await VotingSession.findOne({ isActive: true }).sort({ createdAt: -1 });
}

async function getVoteCount(votingSessionId) {
  return await Vote.countDocuments({ votingSessionId });
}

async function getVoteCountByCompany(votingSessionId, companyId) {
  return await Vote.countDocuments({ votingSessionId, companyId });
}

const adminTokens = new Set();

function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
}

// Public API endpoints

app.get('/api/company/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = await Company.findOne({ id: companyId });

    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    res.json({
      id: company.id,
      name: company.name
    });
  } catch (error) {
    console.error('Error getting company:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/voting/:companyId', async (req, res) => {
  try {
    const { companyId } = req.params;
    const company = await Company.findOne({ id: companyId });

    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const currentVoting = await getCurrentVoting();

    if (!currentVoting) {
      return res.json({ active: false });
    }

    const totalVotes = await getVoteCount(currentVoting.id);
    const companyVotes = await getVoteCountByCompany(currentVoting.id, companyId);

    res.json({
      active: true,
      id: currentVoting.id,
      title: currentVoting.title,
      sections: currentVoting.sections,
      totalVotes,
      companyVotes,
      companyName: company.name
    });
  } catch (error) {
    console.error('Error getting voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/vote', async (req, res) => {
  try {
    const { companyId, votingSessionId, votes, deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ message: 'Device ID is required' });
    }

    const company = await Company.findOne({ id: companyId });
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const votingSession = await VotingSession.findOne({
      id: votingSessionId,
      isActive: true
    });

    if (!votingSession) {
      return res.status(400).json({ message: 'Invalid or expired voting session' });
    }

    // Check if device has voted in the last 3 hours
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const recentVote = await Vote.findOne({
      deviceId,
      votingSessionId,
      timestamp: { $gte: threeHoursAgo }
    });

    if (recentVote) {
      const timeLeft = Math.ceil((recentVote.timestamp.getTime() + 3 * 60 * 60 * 1000 - Date.now()) / 1000 / 60);
      return res.status(429).json({
        message: `You can vote again in ${timeLeft} minutes`,
        timeLeft
      });
    }

    if (!votes || typeof votes !== 'object') {
      return res.status(400).json({ message: 'Invalid votes data' });
    }

    // Validate votes against sections
    for (const section of votingSession.sections) {
      const voteValue = votes[section.id];

      // Check required sections
      if (section.required) {
        if (section.type === 'text-input') {
          if (!voteValue || (typeof voteValue === 'string' && voteValue.trim() === '')) {
            return res.status(400).json({
              message: `Please provide a value for ${section.label}`
            });
          }
        } else {
          if (!voteValue || (Array.isArray(voteValue) && voteValue.length === 0)) {
            return res.status(400).json({
              message: `Please select at least one option for ${section.label}`
            });
          }
        }
      }

      // Validate based on section type
      if (section.type === 'single-select') {
        if (voteValue) {
          const validOptions = section.options.map(opt => opt.name);
          if (!validOptions.includes(voteValue)) {
            return res.status(400).json({
              message: `Invalid option selected for ${section.label}`
            });
          }
        }
      } else if (section.type === 'multi-select') {
        if (voteValue) {
          if (!Array.isArray(voteValue)) {
            return res.status(400).json({
              message: `${section.label} must be an array`
            });
          }

          if (voteValue.length < section.minSelections) {
            return res.status(400).json({
              message: `Please select at least ${section.minSelections} option(s) for ${section.label}`
            });
          }

          if (voteValue.length > section.maxSelections) {
            return res.status(400).json({
              message: `Please select at most ${section.maxSelections} option(s) for ${section.label}`
            });
          }

          const validOptions = section.options.map(opt => opt.name);
          for (const option of voteValue) {
            if (!validOptions.includes(option)) {
              return res.status(400).json({
                message: `Invalid option selected for ${section.label}`
              });
            }
          }
        }
      }
      // text-input type is already validated above for required check
    }

    const newVote = new Vote({
      votingSessionId,
      companyId: companyId,
      votes: votes,
      ipAddress: req.ip || req.connection.remoteAddress,
      deviceId
    });

    await newVote.save();

    res.json({
      success: true,
      message: 'Vote submitted successfully',
      canVoteAgainAt: new Date(Date.now() + 3 * 60 * 60 * 1000)
    });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/results/:votingSessionId', async (req, res) => {
  try {
    const { votingSessionId } = req.params;
    const votingSession = await VotingSession.findOne({ id: votingSessionId });

    if (!votingSession) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    const allVotes = await Vote.find({ votingSessionId });

    // Initialize results structure based on sections
    const results = {};

    votingSession.sections.forEach(section => {
      if (section.type === 'text-input') {
        results[section.id] = {
          type: 'text-input',
          label: section.label,
          responses: []
        };
      } else {
        results[section.id] = {
          type: section.type,
          label: section.label,
          options: {}
        };

        section.options.forEach(option => {
          results[section.id].options[option.name] = {
            votes: 0,
            imageUrl: option.imageUrl
          };
        });
      }
    });

    // Count votes
    allVotes.forEach(voteDoc => {
      const voteData = voteDoc.votes instanceof Map ? Object.fromEntries(voteDoc.votes) : voteDoc.votes;

      votingSession.sections.forEach(section => {
        const sectionVote = voteData[section.id];

        if (section.type === 'text-input') {
          if (sectionVote && sectionVote.trim() !== '') {
            results[section.id].responses.push({
              response: sectionVote,
              timestamp: voteDoc.timestamp
            });
          }
        } else if (section.type === 'single-select') {
          if (sectionVote && results[section.id].options[sectionVote]) {
            results[section.id].options[sectionVote].votes++;
          }
        } else if (section.type === 'multi-select') {
          if (Array.isArray(sectionVote)) {
            sectionVote.forEach(option => {
              if (results[section.id].options[option]) {
                results[section.id].options[option].votes++;
              }
            });
          }
        }
      });
    });

    // Format results
    const formattedResults = {};

    Object.entries(results).forEach(([sectionId, sectionData]) => {
      if (sectionData.type === 'text-input') {
        formattedResults[sectionId] = {
          type: sectionData.type,
          label: sectionData.label,
          responses: sectionData.responses
        };
      } else {
        formattedResults[sectionId] = {
          type: sectionData.type,
          label: sectionData.label,
          options: Object.entries(sectionData.options)
            .map(([name, data]) => ({
              name,
              votes: data.votes,
              imageUrl: data.imageUrl
            }))
            .sort((a, b) => b.votes - a.votes)
        };
      }
    });

    res.json({
      active: votingSession.isActive,
      title: votingSession.title,
      results: formattedResults,
      totalVotes: allVotes.length
    });
  } catch (error) {
    console.error('Error getting results:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get results by company
app.get('/api/results/:votingSessionId/company/:companyId', async (req, res) => {
  try {
    const { votingSessionId, companyId } = req.params;
    const votingSession = await VotingSession.findOne({ id: votingSessionId });

    if (!votingSession) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    const company = await Company.findOne({ id: companyId });
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const companyVotes = await Vote.find({ votingSessionId, companyId });

    // Initialize results structure based on sections
    const results = {};

    votingSession.sections.forEach(section => {
      if (section.type === 'text-input') {
        results[section.id] = {
          type: 'text-input',
          label: section.label,
          responses: []
        };
      } else {
        results[section.id] = {
          type: section.type,
          label: section.label,
          options: {}
        };

        section.options.forEach(option => {
          results[section.id].options[option.name] = {
            votes: 0,
            imageUrl: option.imageUrl
          };
        });
      }
    });

    // Count votes
    companyVotes.forEach(voteDoc => {
      const voteData = voteDoc.votes instanceof Map ? Object.fromEntries(voteDoc.votes) : voteDoc.votes;

      votingSession.sections.forEach(section => {
        const sectionVote = voteData[section.id];

        if (section.type === 'text-input') {
          if (sectionVote && sectionVote.trim() !== '') {
            results[section.id].responses.push({
              response: sectionVote,
              timestamp: voteDoc.timestamp
            });
          }
        } else if (section.type === 'single-select') {
          if (sectionVote && results[section.id].options[sectionVote]) {
            results[section.id].options[sectionVote].votes++;
          }
        } else if (section.type === 'multi-select') {
          if (Array.isArray(sectionVote)) {
            sectionVote.forEach(option => {
              if (results[section.id].options[option]) {
                results[section.id].options[option].votes++;
              }
            });
          }
        }
      });
    });

    // Format results
    const formattedResults = {};

    Object.entries(results).forEach(([sectionId, sectionData]) => {
      if (sectionData.type === 'text-input') {
        formattedResults[sectionId] = {
          type: sectionData.type,
          label: sectionData.label,
          responses: sectionData.responses
        };
      } else {
        formattedResults[sectionId] = {
          type: sectionData.type,
          label: sectionData.label,
          options: Object.entries(sectionData.options)
            .map(([name, data]) => ({
              name,
              votes: data.votes,
              imageUrl: data.imageUrl
            }))
            .sort((a, b) => b.votes - a.votes)
        };
      }
    });

    res.json({
      active: votingSession.isActive,
      title: votingSession.title,
      company: company.name,
      results: formattedResults,
      totalVotes: companyVotes.length
    });
  } catch (error) {
    console.error('Error getting company results:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin API endpoints

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Invalid password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);

  res.json({ token });
});

app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
  res.json({ valid: true });
});

app.post('/api/admin/create-company', authenticateAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Company name is required' });
    }

    const newCompany = new Company({
      id: crypto.randomBytes(16).toString('hex'),
      name
    });

    await newCompany.save();

    res.json({
      success: true,
      message: 'Company created successfully',
      company: newCompany
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/companies', authenticateAdmin, async (req, res) => {
  try {
    const companies = await Company.find().sort({ createdAt: -1 });
    res.json(companies);
  } catch (error) {
    console.error('Error getting companies:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/admin/companies/:companyId', authenticateAdmin, async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findOne({ id: companyId });
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    await Vote.deleteMany({ companyId });
    await Company.deleteOne({ id: companyId });

    res.json({
      success: true,
      message: 'Company and all related votes deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create global voting session
app.post('/api/admin/create-voting', authenticateAdmin, async (req, res) => {
  try {
    const { title, sections } = req.body;

    if (!title || !sections) {
      return res.status(400).json({ message: 'Invalid voting session data' });
    }

    if (!Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ message: 'At least one section is required' });
    }

    // Validate sections
    for (const section of sections) {
      if (!section.id || !section.label || !section.type) {
        return res.status(400).json({
          message: 'Each section must have id, label, and type'
        });
      }

      if (!['single-select', 'multi-select', 'text-input'].includes(section.type)) {
        return res.status(400).json({
          message: 'Invalid section type. Must be single-select, multi-select, or text-input'
        });
      }

      // Validate options for select types
      if (section.type === 'single-select' || section.type === 'multi-select') {
        if (!section.options || !Array.isArray(section.options) || section.options.length === 0) {
          return res.status(400).json({
            message: `Section "${section.label}" must have at least one option`
          });
        }

        for (const option of section.options) {
          if (!option.name) {
            return res.status(400).json({
              message: `Each option in "${section.label}" must have a name`
            });
          }
        }
      }

      // Validate multi-select min/max
      if (section.type === 'multi-select') {
        if (section.minSelections && section.maxSelections &&
            section.minSelections > section.maxSelections) {
          return res.status(400).json({
            message: `In section "${section.label}", minSelections cannot be greater than maxSelections`
          });
        }
      }
    }

    // Deactivate all previous voting sessions
    await VotingSession.updateMany({}, { isActive: false });

    const newVoting = new VotingSession({
      id: crypto.randomBytes(16).toString('hex'),
      title,
      sections: sections,
      isActive: true
    });

    await newVoting.save();

    res.json({
      success: true,
      message: 'Global voting session created successfully',
      voting: newVoting
    });
  } catch (error) {
    console.error('Error creating voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/current-voting', authenticateAdmin, async (req, res) => {
  try {
    const currentVoting = await getCurrentVoting();

    if (!currentVoting) {
      return res.json({ active: false });
    }

    const totalVotes = await getVoteCount(currentVoting.id);

    res.json({
      active: true,
      session: currentVoting,
      totalVotes
    });
  } catch (error) {
    console.error('Error getting current voting:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.patch('/api/admin/voting/:votingSessionId/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { votingSessionId } = req.params;

    const session = await VotingSession.findOne({ id: votingSessionId });
    if (!session) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    session.isActive = !session.isActive;
    await session.save();

    res.json({
      success: true,
      message: `Voting session ${session.isActive ? 'activated' : 'deactivated'}`,
      session
    });
  } catch (error) {
    console.error('Error toggling voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/admin/reset-voting/:votingSessionId', authenticateAdmin, async (req, res) => {
  try {
    const { votingSessionId } = req.params;

    const session = await VotingSession.findOne({ id: votingSessionId });
    if (!session) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    const result = await Vote.deleteMany({ votingSessionId });

    res.json({
      success: true,
      message: 'Voting session reset successfully',
      deletedVotes: result.deletedCount
    });
  } catch (error) {
    console.error('Error resetting voting session:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const companies = await Company.find();
    const currentVoting = await getCurrentVoting();
    const stats = [];

    if (!currentVoting) {
      return res.json([]);
    }

    for (const company of companies) {
      const companyVotes = await Vote.countDocuments({
        votingSessionId: currentVoting.id,
        companyId: company.id
      });

      stats.push({
        company: {
          id: company.id,
          name: company.name,
          createdAt: company.createdAt
        },
        votes: companyVotes
      });
    }

    const totalVotes = await Vote.countDocuments({ votingSessionId: currentVoting.id });

    res.json({
      currentSession: currentVoting,
      totalVotes,
      companies: stats
    });
  } catch (error) {
    console.error('Error getting all stats:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/health', async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];

    res.json({
      status: 'ok',
      database: states[dbState]
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`📊 MongoDB: ${MONGODB_URI}`);
  });
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
