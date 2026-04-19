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
app.use(express.json({ limit: '5mb' }));

// MongoDB Schema Definitions
const companySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const optionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  imageUrl: { type: String },
  instagramUrl: { type: String },
  artistId: { type: String }
}, { _id: false });

const categorySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  icon: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const artistSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  imageUrl: { type: String, default: '' },
  instagramUrl: { type: String, default: '' },
  categoryIds: { type: [String], default: [], index: true },
  createdAt: { type: Date, default: Date.now }
});

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
  venue: { type: String, default: '' },
  venueImageUrl: { type: String, default: '' },
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
const Category = mongoose.model('Category', categorySchema);
const Artist = mongoose.model('Artist', artistSchema);

const instagramProfileSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true, lowercase: true },
  data: { type: mongoose.Schema.Types.Mixed },
  fetchedAt: { type: Date, default: Date.now, index: true },
});
const InstagramProfile = mongoose.model('InstagramProfile', instagramProfileSchema);

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
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
      venue: currentVoting.venue || '',
      venueImageUrl: currentVoting.venueImageUrl || '',
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

// Shared helper: build a per-section results object from a voting session and a
// list of vote documents. Keeps ordering of options stable with their definition
// order in the section, then sorts by votes for select types.
function buildResultsFromVotes(votingSession, voteDocs) {
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
        optionsMap: {},
        optionsOrder: []
      };

      section.options.forEach(option => {
        results[section.id].optionsMap[option.name] = {
          name: option.name,
          votes: 0,
          imageUrl: option.imageUrl || '',
          instagramUrl: option.instagramUrl || '',
          artistId: option.artistId || ''
        };
        results[section.id].optionsOrder.push(option.name);
      });
    }
  });

  voteDocs.forEach(voteDoc => {
    const voteData = voteDoc.votes instanceof Map
      ? Object.fromEntries(voteDoc.votes)
      : voteDoc.votes;

    votingSession.sections.forEach(section => {
      const sectionVote = voteData[section.id];
      const bucket = results[section.id];
      if (!bucket) return;

      if (section.type === 'text-input') {
        if (sectionVote && typeof sectionVote === 'string' && sectionVote.trim() !== '') {
          bucket.responses.push({
            response: sectionVote,
            timestamp: voteDoc.timestamp
          });
        }
      } else if (section.type === 'single-select') {
        if (sectionVote && bucket.optionsMap[sectionVote]) {
          bucket.optionsMap[sectionVote].votes++;
        }
      } else if (section.type === 'multi-select') {
        if (Array.isArray(sectionVote)) {
          sectionVote.forEach(opt => {
            if (bucket.optionsMap[opt]) {
              bucket.optionsMap[opt].votes++;
            }
          });
        }
      }
    });
  });

  const formatted = {};
  Object.entries(results).forEach(([sectionId, data]) => {
    if (data.type === 'text-input') {
      formatted[sectionId] = {
        type: data.type,
        label: data.label,
        responses: data.responses
      };
    } else {
      const options = data.optionsOrder
        .map(name => data.optionsMap[name])
        .filter(Boolean)
        .sort((a, b) => b.votes - a.votes);
      formatted[sectionId] = {
        type: data.type,
        label: data.label,
        options
      };
    }
  });

  return formatted;
}

app.get('/api/results/:votingSessionId', async (req, res) => {
  try {
    const { votingSessionId } = req.params;
    const votingSession = await VotingSession.findOne({ id: votingSessionId });

    if (!votingSession) {
      return res.status(404).json({ message: 'Voting session not found' });
    }

    const allVotes = await Vote.find({ votingSessionId });
    const formattedResults = buildResultsFromVotes(votingSession, allVotes);

    res.json({
      active: votingSession.isActive,
      title: votingSession.title,
      venue: votingSession.venue || '',
      venueImageUrl: votingSession.venueImageUrl || '',
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
    const formattedResults = buildResultsFromVotes(votingSession, companyVotes);

    res.json({
      active: votingSession.isActive,
      title: votingSession.title,
      venue: votingSession.venue || '',
      venueImageUrl: votingSession.venueImageUrl || '',
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

// Category management

app.get('/api/admin/categories', authenticateAdmin, async (req, res) => {
  try {
    const categories = await Category.find().sort({ createdAt: -1 });
    res.json(categories);
  } catch (error) {
    console.error('Error getting categories:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/admin/categories', authenticateAdmin, async (req, res) => {
  try {
    const { name, icon } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Category name is required' });
    }

    const newCategory = new Category({
      id: crypto.randomBytes(12).toString('hex'),
      name: name.trim(),
      icon: (icon || '').trim()
    });

    await newCategory.save();

    res.json({
      success: true,
      message: 'Category created successfully',
      category: newCategory
    });
  } catch (error) {
    console.error('Error creating category:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.patch('/api/admin/categories/:categoryId', authenticateAdmin, async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { name, icon } = req.body;

    const category = await Category.findOne({ id: categoryId });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    if (typeof name === 'string' && name.trim()) category.name = name.trim();
    if (typeof icon === 'string') category.icon = icon.trim();

    await category.save();

    res.json({
      success: true,
      message: 'Category updated successfully',
      category
    });
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/admin/categories/:categoryId', authenticateAdmin, async (req, res) => {
  try {
    const { categoryId } = req.params;

    const category = await Category.findOne({ id: categoryId });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    // Remove this category from any artist that references it
    await Artist.updateMany(
      { categoryIds: categoryId },
      { $pull: { categoryIds: categoryId } }
    );

    await Category.deleteOne({ id: categoryId });

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Artist management

app.get('/api/admin/artists', authenticateAdmin, async (req, res) => {
  try {
    const { categoryId, search } = req.query;
    const query = {};

    if (categoryId) {
      query.categoryIds = categoryId;
    }
    if (search && search.trim()) {
      // Escape special regex characters
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.name = { $regex: escaped, $options: 'i' };
    }

    const artists = await Artist.find(query).sort({ name: 1 });
    res.json(artists);
  } catch (error) {
    console.error('Error getting artists:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/admin/artists', authenticateAdmin, async (req, res) => {
  try {
    const { name, imageUrl, instagramUrl, categoryIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Artist name is required' });
    }

    const cleanImage = (imageUrl || '').trim();
    const cleanInsta = (instagramUrl || '').trim();

    if (!cleanImage && !cleanInsta) {
      return res.status(400).json({
        message: 'Please provide either an image URL or an Instagram URL'
      });
    }

    const newArtist = new Artist({
      id: crypto.randomBytes(12).toString('hex'),
      name: name.trim(),
      imageUrl: cleanImage,
      instagramUrl: cleanInsta,
      categoryIds: Array.isArray(categoryIds) ? categoryIds.filter(Boolean) : []
    });

    await newArtist.save();

    res.json({
      success: true,
      message: 'Artist created successfully',
      artist: newArtist
    });
  } catch (error) {
    console.error('Error creating artist:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.patch('/api/admin/artists/:artistId', authenticateAdmin, async (req, res) => {
  try {
    const { artistId } = req.params;
    const { name, imageUrl, instagramUrl, categoryIds } = req.body;

    const artist = await Artist.findOne({ id: artistId });
    if (!artist) {
      return res.status(404).json({ message: 'Artist not found' });
    }

    if (typeof name === 'string' && name.trim()) artist.name = name.trim();
    if (typeof imageUrl === 'string') artist.imageUrl = imageUrl.trim();
    if (typeof instagramUrl === 'string') artist.instagramUrl = instagramUrl.trim();
    if (Array.isArray(categoryIds)) artist.categoryIds = categoryIds.filter(Boolean);

    if (!artist.imageUrl && !artist.instagramUrl) {
      return res.status(400).json({
        message: 'Artist must have either an image URL or an Instagram URL'
      });
    }

    await artist.save();

    res.json({
      success: true,
      message: 'Artist updated successfully',
      artist
    });
  } catch (error) {
    console.error('Error updating artist:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/admin/artists/:artistId', authenticateAdmin, async (req, res) => {
  try {
    const { artistId } = req.params;

    const artist = await Artist.findOne({ id: artistId });
    if (!artist) {
      return res.status(404).json({ message: 'Artist not found' });
    }

    await Artist.deleteOne({ id: artistId });

    res.json({
      success: true,
      message: 'Artist deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting artist:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create global voting session
app.post('/api/admin/create-voting', authenticateAdmin, async (req, res) => {
  try {
    const { title, venue, venueImageUrl, sections } = req.body;

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
      venue: (venue || '').trim(),
      venueImageUrl: (venueImageUrl || '').trim(),
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

// Instagram profile lookup via Instagram's own web_profile_info endpoint.
// Requires X-IG-App-ID and works unauthenticated for public profiles.
//
// Caching has two layers:
//   L1 in-memory: 1h positive hits — serves almost every request
//   L2 MongoDB: 7 day max age, stale-while-error — if upstream 429s we
//               fall back to the last successful fetch even if "expired"
//
// Meta aggressively rate-limits datacenter IPs, so the only way this
// endpoint stays reliable is to do as few upstream calls as possible
// and keep serving the last known data when they block us.
const IG_L1 = new Map();
const IG_L1_NEG = new Map();
const IG_L1_TTL = 60 * 60 * 1000;          // 1h positive
const IG_L1_NEG_TTL = 90 * 1000;           // 90s negative — stop hammering upstream
const IG_L2_FRESH = 12 * 60 * 60 * 1000;   // 12h — treat Mongo as fresh
const IG_L2_STALE = 7 * 24 * 60 * 60 * 1000; // 7d — still serve on error

function igBrowserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '129477',
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'Referer': 'https://www.instagram.com/',
    'Origin': 'https://www.instagram.com',
  };
}

// Proxy Instagram CDN images through wsrv.nl so:
// 1. Signed scontent URLs that expire in 24-48h get cached on wsrv.nl's CDN
// 2. Browser never hits instagram CDN directly (no region/referrer issues)
// 3. CORS * header from wsrv.nl means any frontend can load them
function proxyImg(url, size) {
  if (!url) return null;
  const params = new URLSearchParams({ url, w: String(size), h: String(size), fit: 'cover', n: '-1' });
  return `https://wsrv.nl/?${params.toString()}`;
}

function normalizeIgProfile(user) {
  const allEdges = user.edge_owner_to_timeline_media?.edges || [];

  // Prefer image posts over reels/videos — reel thumbnails are video
  // frame captures that image proxies sometimes fail on.
  const imageEdges = allEdges.filter((e) => !e.node.is_video);
  const videoEdges = allEdges.filter((e) => e.node.is_video);
  const bestEdges = [...imageEdges, ...videoEdges].slice(0, 3);

  const posts = bestEdges
    .map((e) => ({
      image: proxyImg(e.node.thumbnail_src || e.node.display_url, 640),
      shortcode: e.node.shortcode,
      postUrl: `https://www.instagram.com/p/${e.node.shortcode}/`,
      isVideo: !!e.node.is_video,
    }))
    .filter((p) => p.image);

  return {
    username: user.username,
    fullName: user.full_name || null,
    profilePic: proxyImg(user.profile_pic_url_hd || user.profile_pic_url, 320),
    isPrivate: !!user.is_private,
    followerCount: user.edge_followed_by?.count ?? null,
    postCount: user.edge_owner_to_timeline_media?.count ?? null,
    posts,
  };
}

async function fetchIgFromUpstream(username) {
  // Try the primary endpoint first, fall back to the www.instagram.com host
  // which sometimes has different rate limits.
  const endpoints = [
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
  ];
  let lastErr = null;
  for (const url of endpoints) {
    try {
      const upstream = await fetch(url, {
        headers: igBrowserHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (upstream.status === 429) { lastErr = { status: 429, msg: 'rate limited' }; continue; }
      if (!upstream.ok) { lastErr = { status: upstream.status, msg: `upstream ${upstream.status}` }; continue; }
      const json = await upstream.json();
      const user = json && json.data && json.data.user;
      if (!user) { lastErr = { status: 404, msg: 'user not found' }; continue; }
      return { ok: true, data: normalizeIgProfile(user) };
    } catch (err) {
      lastErr = { status: 502, msg: err.message || 'fetch failed' };
    }
  }
  return { ok: false, status: lastErr?.status || 502, error: lastErr?.msg || 'fetch failed' };
}

app.get('/api/instagram/:username', async (req, res) => {
  const username = String(req.params.username || '').trim().toLowerCase();
  if (!username || !/^[a-zA-Z0-9_.]{1,30}$/.test(username)) {
    return res.status(400).json({ error: 'invalid username' });
  }

  // L1: in-memory fresh cache
  const l1 = IG_L1.get(username);
  if (l1 && l1.expires > Date.now()) {
    res.set('X-Cache', 'L1');
    return res.json(l1.data);
  }

  // L2: Mongo cache — check freshness
  let mongoDoc = null;
  try { mongoDoc = await InstagramProfile.findOne({ username }); } catch {}
  if (mongoDoc && Date.now() - mongoDoc.fetchedAt.getTime() < IG_L2_FRESH) {
    IG_L1.set(username, { data: mongoDoc.data, expires: Date.now() + IG_L1_TTL });
    res.set('X-Cache', 'L2');
    return res.json(mongoDoc.data);
  }

  // Short-circuit if we recently failed — avoids hammering upstream on
  // every page view when Meta is rate-limiting us.
  const neg = IG_L1_NEG.get(username);
  if (neg && neg.expires > Date.now()) {
    if (mongoDoc && Date.now() - mongoDoc.fetchedAt.getTime() < IG_L2_STALE) {
      res.set('X-Cache', 'STALE');
      return res.json(mongoDoc.data);
    }
    res.set('X-Cache', 'NEG');
    return res.status(neg.status).json({ error: neg.error, username });
  }

  // Upstream
  const result = await fetchIgFromUpstream(username);
  if (result.ok) {
    try {
      await InstagramProfile.findOneAndUpdate(
        { username },
        { username, data: result.data, fetchedAt: new Date() },
        { upsert: true }
      );
    } catch (err) { console.error('ig mongo upsert err', err.message); }
    IG_L1.set(username, { data: result.data, expires: Date.now() + IG_L1_TTL });
    IG_L1_NEG.delete(username);
    res.set('X-Cache', 'MISS');
    return res.json(result.data);
  }

  // Record the failure for a short window so we don't re-hit upstream
  IG_L1_NEG.set(username, { status: result.status, error: result.error, expires: Date.now() + IG_L1_NEG_TTL });

  // Upstream failed — serve stale Mongo data if we have anything under IG_L2_STALE
  if (mongoDoc && Date.now() - mongoDoc.fetchedAt.getTime() < IG_L2_STALE) {
    res.set('X-Cache', 'STALE');
    return res.json(mongoDoc.data);
  }

  res.set('X-Cache', 'ERROR');
  return res.status(result.status).json({ error: result.error, username });
});

// Admin-only: manually seed the Instagram cache for a username. Because Meta
// rate-limits datacenter IPs, the only reliable way to populate this cache is
// from a residential browser session. The workflow:
//   1. admin opens https://www.instagram.com/<username>/ in their browser
//   2. opens devtools → console, pastes the one-liner we document in the
//      admin panel, which calls web_profile_info same-origin and copies the
//      resulting JSON to the clipboard
//   3. admin pastes the JSON into the admin panel and hits "Seed"
//   4. this endpoint normalizes and stores it in Mongo for 12h fresh / 7d stale
app.post('/api/admin/instagram/seed', authenticateAdmin, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!username || !/^[a-zA-Z0-9_.]{1,30}$/.test(username)) {
    return res.status(400).json({ error: 'invalid username' });
  }
  const raw = req.body.raw;
  if (!raw || typeof raw !== 'object') {
    return res.status(400).json({ error: 'raw Instagram API response required in body' });
  }

  // Accept either the full { data: { user: {...} } } envelope or just the
  // user object itself, or our already-normalized shape.
  let data;
  try {
    if (raw.data && raw.data.user) {
      data = normalizeIgProfile(raw.data.user);
    } else if (raw.user) {
      data = normalizeIgProfile(raw.user);
    } else if (raw.edge_owner_to_timeline_media || raw.profile_pic_url || raw.profile_pic_url_hd) {
      data = normalizeIgProfile(raw);
    } else if (raw.profilePic !== undefined || raw.posts !== undefined) {
      data = raw; // already normalized
    } else {
      return res.status(400).json({ error: 'unrecognized JSON shape — paste the full web_profile_info response' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'failed to parse: ' + err.message });
  }

  if (!data.username) data.username = username;

  try {
    await InstagramProfile.findOneAndUpdate(
      { username },
      { username, data, fetchedAt: new Date() },
      { upsert: true }
    );
  } catch (err) {
    console.error('ig seed mongo upsert err', err.message);
    return res.status(500).json({ error: 'db upsert failed' });
  }

  IG_L1.set(username, { data, expires: Date.now() + IG_L1_TTL });
  IG_L1_NEG.delete(username);
  res.json({ seeded: true, username, data });
});

// Admin-only: list all currently cached Instagram usernames so the admin
// panel can show what's primed and what isn't.
app.get('/api/admin/instagram/cached', authenticateAdmin, async (req, res) => {
  try {
    const docs = await InstagramProfile.find({}, { username: 1, fetchedAt: 1, 'data.profilePic': 1, 'data.fullName': 1, 'data.posts': 1 }).sort({ fetchedAt: -1 });
    res.json(docs.map((d) => ({
      username: d.username,
      fetchedAt: d.fetchedAt,
      profilePic: d.data?.profilePic || null,
      fullName: d.data?.fullName || null,
      postCount: (d.data?.posts || []).length,
    })));
  } catch (err) {
    res.status(500).json({ error: 'db read failed' });
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
